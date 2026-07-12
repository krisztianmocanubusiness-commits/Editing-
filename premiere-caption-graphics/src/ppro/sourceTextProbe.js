/**
 * Narrowly-scoped Source Text read/write round-trip diagnostic. Separate
 * from src/ppro/diagnostics.js's Diagnostic Inspector on purpose — the
 * task that added this explicitly did not want a full generic deep probe
 * (classification report + raw probe + textComponentProbe) re-run every
 * time someone just wants to test whether writing to `AE.ADBE Text`'s
 * `Source Text` param actually works. This module inserts its own
 * temporary clip, waits for the component chain to stabilize, locates
 * `Source Text` by displayName (component index 3 / param index 0 are
 * kept only as diagnostic metadata once found, never as the sole lookup
 * strategy — a different .mogrt could expose it at a different index),
 * and runs exactly one thing: can this extension read it, construct a
 * sentinel keyframe for it, apply that as a real set-value action on the
 * temporary clip, and read the sentinel back?
 *
 * Confirmed real-host finding this exists to test (see
 * docs/MOGRT_DIAGNOSTIC.md): `Source Text` reports `isTimeVarying: false`
 * and `areKeyframesSupported: false`, and `getStartValue()` returns `null`
 * for it — `getValueAtTime(time)` (with a real TickTime, never called with
 * no argument — see NEVER_AUTO_CALL_EXACT_NAMES in ./deepProbe.js) is the
 * documented read path instead.
 */
import { getPpro } from "./client.js";
import { tickToSec } from "./time.js";
import { requireActiveProjectAndSequence, resolveInsertionTimeSec, listVideoTracks } from "./timelineRange.js";
import { insertMogrtAt, removeTrackItem } from "./mogrt.js";
import { safe, safeAsync, safeResolve, isPromiseLike, resolveHostValueDetailed } from "./introspect.js";
import { summarizeHostValue, unwrapValueDeep, createScanBudget, probeObjectShape, PROBE_CALL_TIMEOUT_MS } from "./deepProbe.js";
import {
  discoverComponents,
  readDisplayName,
  readParamCount,
  stabilizeComponentChain,
  runScanWithGuaranteedCleanup,
  MOGRT_INIT_TIMEOUT_MESSAGE,
} from "./diagnostics.js";

const MAX_PARAM_SCAN = 64;
const CONSECUTIVE_MISS_TOLERANCE = 3;
const READ_BACK_SETTLE_DELAY_MS = 200;

export const DEFAULT_SENTINEL = "KERIS_DIAGNOSTIC_SENTINEL";
export const DEFAULT_ROUND_TRIP_BUDGET_MS = 8000;

/**
 * Finds the AE.ADBE Text component on an already-fetched chain — a thin
 * wrapper over discoverComponents() so this module doesn't re-implement
 * component classification.
 */
export async function locateTextComponent(chain, log) {
  const discovery = await discoverComponents(chain, log, undefined);
  const textInfo = discovery.components.find((c) => c.classification === "text-editing");
  return { textInfo: textInfo ?? null, discoveredComponents: discovery.components };
}

/**
 * Finds the "Source Text" param on a component by DISPLAY NAME — never by
 * assuming a fixed index. Component index 3 / param index 0 were observed
 * on one real MOGRT; a different template could expose Source Text at a
 * different param index, or even (in principle) on a differently-indexed
 * AE.ADBE Text component, so every lookup here re-derives both.
 */
export async function locateSourceTextParam(component, componentIndex, log) {
  const paramCount = await readParamCount(component, componentIndex, log);
  const upperBound = typeof paramCount === "number" ? paramCount : MAX_PARAM_SCAN;
  let consecutiveMisses = 0;

  for (let pi = 0; pi < upperBound; pi++) {
    const paramResult = await safeResolve(() => component.getParam(pi), { log, label: `sourceText.locate.param[${pi}]` });
    if (!paramResult.ok || !paramResult.value) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= CONSECUTIVE_MISS_TOLERANCE) break;
      continue;
    }
    consecutiveMisses = 0;
    const param = paramResult.value;
    const displayName = await readDisplayName(param, log);
    if (displayName && displayName.trim().toLowerCase() === "source text") {
      return { param, paramIndex: pi, displayName };
    }
  }
  return null;
}

/** Best-effort midpoint TickTime (trackItem's in-point + half its duration) — "optionally" per the task, never required. */
export async function computeMidpointTickTime(trackItem, ppro, log) {
  const inResult = await safeResolve(() => trackItem.getInPoint(), { log, label: "trackItem.getInPoint() (midpoint calc)" });
  const durResult = await safeResolve(() => trackItem.getDuration(), { log, label: "trackItem.getDuration() (midpoint calc)" });
  if (!inResult.ok || !durResult.ok) return null;
  const inSec = safe(() => tickToSec(inResult.value)).value;
  const durSec = safe(() => tickToSec(durResult.value)).value;
  if (typeof inSec !== "number" || typeof durSec !== "number") return null;
  return safe(() => ppro.TickTime.createWithSeconds(inSec + durSec / 2)).value ?? null;
}

/**
 * Reads Source Text with several explicit, labelled, valid TickTime
 * arguments — NEVER `getValueAtTime()` with no argument (see
 * NEVER_AUTO_CALL_EXACT_NAMES in ./deepProbe.js for why that hangs/lies
 * about being safe). Each attempt is independently timeout-guarded, so one
 * bad attempt can't block the others.
 */
export async function readSourceTextAttempts(trackItem, param, ppro, log, budget) {
  const attempts = [
    { label: "TickTime.createWithSeconds(0)", getTime: () => ppro.TickTime.createWithSeconds(0) },
    { label: "trackItem.getInPoint()", getTime: () => trackItem.getInPoint() },
    { label: "trackItem.getStartTime()", getTime: () => trackItem.getStartTime() },
  ];
  const midpoint = await computeMidpointTickTime(trackItem, ppro, log);
  if (midpoint) {
    attempts.push({ label: "midpoint (getInPoint + getDuration/2)", getTime: () => midpoint });
  }

  const results = [];
  for (const attempt of attempts) {
    if (budget && budget.isExpired()) {
      results.push({ label: attempt.label, ok: false, skipped: true, reason: budget.reason() });
      continue;
    }
    const timeResult = await safeResolve(attempt.getTime, { log, label: `${attempt.label} (construct TickTime)` });
    if (!timeResult.ok) {
      results.push({
        label: attempt.label,
        ok: false,
        timeConstructionError: timeResult.timedOut ? "timed out" : String(timeResult.error?.message || timeResult.error),
      });
      continue;
    }
    const valueResult = await safeResolve(() => param.getValueAtTime(timeResult.value), {
      log,
      label: `getValueAtTime(${attempt.label})`,
      timeoutMs: PROBE_CALL_TIMEOUT_MS,
    });
    if (!valueResult.ok) {
      results.push({
        label: attempt.label,
        ok: false,
        timedOut: Boolean(valueResult.timedOut),
        error: valueResult.timedOut ? "timed out" : String(valueResult.error?.message || valueResult.error),
      });
      continue;
    }
    const rawSummary = summarizeHostValue(valueResult.value);
    const resolvedValue = await unwrapValueDeep(valueResult.value, log, { label: `getValueAtTime(${attempt.label})` });
    results.push({ label: attempt.label, ok: true, rawSummary, resolvedValue });
  }
  return results;
}

const VALUE_GETTER_NAME_PATTERN = /value/i;
const NON_MUTATING_EXCLUDE_PATTERNS = [/AtTime$/i, /Keyframe/i, /^create/i, /^set/i, /^find/i];

/** Never call something that looks like a keyframe/time-based/mutating method by name alone, regardless of what else its name contains. */
function isSafeNonMutatingFieldName(name) {
  return !NON_MUTATING_EXCLUDE_PATTERNS.some((re) => re.test(name));
}

/** A method name that looks like a plain, non-keyframed, non-time-based value getter by name alone. */
function isPlausibleValueGetterMethod(name) {
  if (!VALUE_GETTER_NAME_PATTERN.test(name)) return false;
  return isSafeNonMutatingFieldName(name);
}

/**
 * Attempts exactly one read — a zero-argument method call or a plain
 * property access — on `param`, logging every axis the task requires:
 * `typeof` the member, the exact arguments passed (always none — every
 * candidate here is either a zero-arg getter method or a plain property),
 * the raw returned value's Promise-ness, the resolved value's shape
 * (`summarizeHostValue`), the deeply-unwrapped `resolvedValue`, and — when
 * the resolved value is itself a wrapper object — that wrapper's own full
 * prototype/property shape (`probeObjectShape`), not just a summary.
 * Never throws, never calls anything that could mutate the sequence.
 */
async function attemptRead({ param, name, kind, log, budget }) {
  if (budget && budget.isExpired()) {
    return { name, kind, skipped: true, reason: budget.reason() };
  }
  const typeofMember = safe(() => typeof param[name]).value ?? "undefined";
  log(`[readSourceTextOnly] ${name} (${kind}): typeof=${typeofMember}, args=()`, "info");

  if (kind === "method" && typeofMember !== "function") {
    return { name, kind, typeofMember, ok: false, error: "not a function on this ComponentParam" };
  }

  const raw = safe(() => (kind === "method" ? param[name]() : param[name]));
  if (!raw.ok) {
    log(`[readSourceTextOnly] ${name} threw synchronously: ${raw.error.message || raw.error}`, "warn");
    return { name, kind, typeofMember, ok: false, threwSynchronously: true, error: String(raw.error.message || raw.error) };
  }

  const isPromise = isPromiseLike(raw.value);
  log(`[readSourceTextOnly] ${name}: raw isPromise=${isPromise}`, "info");

  const resolved = await resolveHostValueDetailed(raw.value, { log, label: `sourceTextParam.${name}`, timeoutMs: PROBE_CALL_TIMEOUT_MS });
  if (!resolved.ok) {
    return {
      name,
      kind,
      typeofMember,
      ok: false,
      isPromise,
      timedOut: Boolean(resolved.timedOut),
      error: resolved.timedOut ? "timed out" : String(resolved.error?.message || resolved.error),
    };
  }

  const rawSummary = summarizeHostValue(resolved.value);
  const resolvedValue = await unwrapValueDeep(resolved.value, log, { label: `sourceTextParam.${name}` });
  const wrapperShape =
    resolved.value !== null && typeof resolved.value === "object"
      ? await probeObjectShape(resolved.value, `sourceTextParam.${name}() result`, log, budget)
      : null;

  log(
    `[readSourceTextOnly] ${name} resolved: ${JSON.stringify(resolvedValue)} (raw kind: ${rawSummary.kind})`,
    resolvedValue !== null && resolvedValue !== undefined ? "success" : "warn"
  );

  return { name, kind, typeofMember, ok: true, isPromise, rawSummary, resolvedValue, wrapperShape };
}

/**
 * Dedicated READ-ONLY diagnostic for Source Text — never calls
 * `createKeyframe` or anything else that could mutate the sequence. Built
 * because a confirmed real-host run showed the old, keyframe-first read
 * strategy failing outright: `createKeyframe(sentinel)` threw "Illegal
 * Parameter type" for a param that reports `areKeyframesSupported: false`
 * — the API telling us plainly this param isn't keyframe-based, so
 * treating a time-based/keyframe-shaped read as the primary path was the
 * wrong strategy for a non-time-varying param.
 *
 * Tries, in order, every plausible non-keyframed value getter:
 *   1. `getValue()` — the documented current-value getter for a
 *      non-time-varying param, tried first and explicitly by name.
 *   2. `.value` as a plain property (some param types may expose it
 *      directly, no method call needed).
 *   3. `getStartValue()` — already known from earlier runs to return
 *      `null` for Source Text; re-checked here for one complete dump.
 *   4. Every OTHER method discovered on the param's prototype chain whose
 *      name contains "value" and isn't a keyframe/AtTime/create/set/find
 *      method — covers "any documented current-value getter" without
 *      hardcoding an exhaustive guess list.
 *   5. `getValueAtTime(TickTime)` — kept, but demoted to just one more
 *      attempt among several rather than the primary strategy; always
 *      called with a real, valid TickTime, never bare.
 *
 * @param {*} param
 * @param {*} ppro
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function readSourceTextValueOnly(param, ppro, trackItem, log, budget) {
  log("[stage] reading Source Text via non-keyframed value getters (createKeyframe is never called here)…", "info");

  const paramShape = await probeObjectShape(param, "sourceTextParam", log, budget);
  log(
    `[readSourceTextOnly] ComponentParam prototype methods: ${(paramShape.prototypeMethodNames ?? []).join(", ") || "(none discovered)"}`,
    "info"
  );

  const attempts = [];
  const tried = new Set();

  attempts.push(await attemptRead({ param, name: "getValue", kind: "method", log, budget }));
  tried.add("getValue");

  attempts.push(await attemptRead({ param, name: "value", kind: "property", log, budget }));
  tried.add("value");

  attempts.push(await attemptRead({ param, name: "getStartValue", kind: "method", log, budget }));
  tried.add("getStartValue");

  const discoveredNames = (paramShape.prototypeMethodNames ?? []).filter((name) => isPlausibleValueGetterMethod(name) && !tried.has(name));
  for (const name of discoveredNames) {
    // eslint-disable-next-line no-await-in-loop
    attempts.push(await attemptRead({ param, name, kind: "method", log, budget }));
    tried.add(name);
  }

  log("[stage] also trying getValueAtTime(TickTime) — kept as a fallback, never prioritized or called bare…", "info");
  const getValueAtTimeAttempts = await readSourceTextAttempts(trackItem, param, ppro, log, budget);

  const workingValueAttempt = attempts.find((a) => a.ok && a.resolvedValue !== null && a.resolvedValue !== undefined);
  const workingTimeAttempt = getValueAtTimeAttempts.find((a) => a.ok && a.resolvedValue !== null && a.resolvedValue !== undefined);
  const workingMethod = workingValueAttempt ? workingValueAttempt.name : workingTimeAttempt ? "getValueAtTime" : null;
  const resolvedValue = workingValueAttempt ? workingValueAttempt.resolvedValue : workingTimeAttempt ? workingTimeAttempt.resolvedValue : null;

  if (workingMethod) {
    log(`✓ Source Text read successfully via ${workingMethod}(): ${JSON.stringify(resolvedValue)}`, "success");
  } else {
    log("✗ No read method returned a usable Source Text value.", "warn");
  }

  return { paramShape, valueGetterAttempts: attempts, getValueAtTimeAttempts, workingMethod, resolvedValue };
}

// Names to look for directly on a returned keyframe object — the task's
// exact list: value, getValue, text, string, sourceText, plus their
// get-prefixed method forms. Tried by exact name first, before the
// broader reflection scan below.
const KEYFRAME_FIELD_CANDIDATES = ["value", "getValue", "text", "getText", "string", "getString", "sourceText", "getSourceText"];

/**
 * Dumps a returned keyframe object's full shape (every own + inherited
 * property/method name, via the same `probeObjectShape` used elsewhere in
 * this module) and tries every plausible text-bearing field on it: the
 * exact named candidates above, then any other field/method whose name
 * contains "value", "text", or "string" and isn't itself a keyframe/
 * AtTime/create/set/find method (so this can never accidentally call
 * something mutating just because of a name match). Also runs
 * `unwrapValueDeep` on the keyframe object itself as a catch-all, in case
 * the text is reachable by a direct unwrap without needing a named field
 * at all (e.g. a bare single-field wrapper).
 *
 * @param {*} keyframeObj
 * @param {string} label
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
async function dumpKeyframeObjectShape(keyframeObj, label, log, budget) {
  const shape = await probeObjectShape(keyframeObj, label, log, budget);
  log(
    `[exploreKeyframe] ${label} — constructor=${shape.constructorName ?? "n/a"}, methods=[${(shape.prototypeMethodNames ?? []).join(", ") || "none"}], ` +
      `properties=[${(shape.prototypeNonMethodNames ?? []).join(", ") || "none"}]`,
    "info"
  );

  const allNames = [...new Set([...(shape.prototypeMethodNames ?? []), ...(shape.prototypeNonMethodNames ?? []), ...(shape.ownKeys ?? [])])];
  const attempts = [];
  const tried = new Set();

  for (const name of KEYFRAME_FIELD_CANDIDATES) {
    if (!allNames.includes(name)) continue;
    const kind = (shape.prototypeMethodNames ?? []).includes(name) ? "method" : "property";
    // eslint-disable-next-line no-await-in-loop
    attempts.push(await attemptRead({ param: keyframeObj, name, kind, log, budget }));
    tried.add(name);
  }

  const broaderNames = allNames.filter((name) => !tried.has(name) && /(value|text|string)/i.test(name) && isSafeNonMutatingFieldName(name));
  for (const name of broaderNames) {
    const kind = (shape.prototypeMethodNames ?? []).includes(name) ? "method" : "property";
    // eslint-disable-next-line no-await-in-loop
    attempts.push(await attemptRead({ param: keyframeObj, name, kind, log, budget }));
    tried.add(name);
  }

  const directUnwrap = await unwrapValueDeep(keyframeObj, log, { label: `${label} (direct unwrap)` });

  const workingAttempt = attempts.find((a) => a.ok && a.resolvedValue !== null && a.resolvedValue !== undefined);
  const workingField = workingAttempt ? workingAttempt.name : directUnwrap !== null && directUnwrap !== undefined ? "(direct unwrap)" : null;
  const resolvedValue = workingAttempt ? workingAttempt.resolvedValue : directUnwrap;

  return { label, shape, fieldAttempts: attempts, directUnwrap, workingField, resolvedValue };
}

/**
 * Dedicated exploration of `ComponentParam`'s keyframe API — built because
 * a confirmed real-host run showed `getValueAtTime` returning the explicit
 * host message "Use GetKeyframeAtTime to get a keyframe object at time.
 * The value can be extracted from the keyframe object.", for a param that
 * ALSO reports `areKeyframesSupported: false`. So this param apparently
 * still exposes a keyframe-shaped access path despite that flag — this
 * function investigates it without ever calling `createKeyframe` (still
 * gated on `areKeyframesSupported`, unrelated to this exploration) or any
 * other method that could mutate the sequence.
 *
 * 1. `getKeyframeListAsTickTimes()` — enumerates existing keyframe times,
 *    if any. Tried first since `getKeyframePtr` may need a real index from
 *    this list rather than an arbitrary guess.
 * 2. `getKeyframePtr(index)` — tried at every index the list produced, or
 *    a single best-effort `getKeyframePtr(0)` if the list came back empty
 *    (a non-time-varying param may still expose exactly one implicit
 *    keyframe holding its static value, even with nothing enumerated).
 * 3. `getKeyframeAtTime(TickTime)` — the exact method the host error
 *    message pointed us at, tried with every enumerated keyframe time plus
 *    the same valid-TickTime candidates used elsewhere in this module
 *    (never called with no argument).
 *
 * Whatever object any of these calls returns is deep-dumped via
 * `dumpKeyframeObjectShape()` above.
 *
 * @param {*} param
 * @param {*} ppro
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function exploreKeyframeObject(param, ppro, trackItem, log, budget) {
  log("[stage] exploring the ComponentParam keyframe API (getKeyframeListAsTickTimes, getKeyframePtr, getKeyframeAtTime)…", "info");

  const hasList = safe(() => typeof param.getKeyframeListAsTickTimes).value === "function";
  log(`[exploreKeyframe] getKeyframeListAsTickTimes: typeof=${hasList ? "function" : "undefined"}`, "info");

  let keyframeTimes = [];
  let listOk = false;
  let listError = null;
  if (hasList) {
    const listResult = await safeResolve(() => param.getKeyframeListAsTickTimes(), {
      log,
      label: "getKeyframeListAsTickTimes()",
      timeoutMs: PROBE_CALL_TIMEOUT_MS,
    });
    listOk = listResult.ok;
    if (listResult.ok) {
      keyframeTimes = Array.isArray(listResult.value) ? listResult.value : listResult.value ? [listResult.value] : [];
      log(`[exploreKeyframe] getKeyframeListAsTickTimes(): ${keyframeTimes.length} keyframe time(s) found`, "info");
    } else {
      listError = listResult.timedOut ? "timed out" : String(listResult.error?.message || listResult.error);
      log(`[exploreKeyframe] getKeyframeListAsTickTimes() failed: ${listError}`, "warn");
    }
  }

  const explorations = [];

  // CONFIRMED (Adobe's official docs, AdobeDocs/uxp-premiere-pro
  // src/pages/ppro-reference/classes/componentparam.md): "getKeyframePtr —
  // Get the Keyframe at the given tickTime position" — this takes a
  // TickTime, NOT an integer index (an earlier version of this function
  // incorrectly assumed an index; fixed here once the official docs were
  // actually checked). Falls back to TickTime.createWithSeconds(0) if no
  // keyframe times were enumerated.
  const hasPtr = safe(() => typeof param.getKeyframePtr).value === "function";
  log(`[exploreKeyframe] getKeyframePtr: typeof=${hasPtr ? "function" : "undefined"}`, "info");
  if (hasPtr) {
    let ptrTimeCandidates = keyframeTimes.map((t, i) => ({ label: `enumerated keyframe time [${i}]`, time: t }));
    if (ptrTimeCandidates.length === 0) {
      const zeroResult = await safeResolve(() => ppro.TickTime.createWithSeconds(0), { log, label: "TickTime.createWithSeconds(0) (getKeyframePtr fallback)" });
      if (zeroResult.ok) ptrTimeCandidates = [{ label: "TickTime.createWithSeconds(0)", time: zeroResult.value }];
    }
    for (const { label: timeLabel, time } of ptrTimeCandidates) {
      if (budget && budget.isExpired()) break;
      // eslint-disable-next-line no-await-in-loop
      const ptrResult = await safeResolve(() => param.getKeyframePtr(time), { log, label: `getKeyframePtr(${timeLabel})`, timeoutMs: PROBE_CALL_TIMEOUT_MS });
      if (ptrResult.ok && ptrResult.value !== null && ptrResult.value !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        const dump = await dumpKeyframeObjectShape(ptrResult.value, `getKeyframePtr(${timeLabel})`, log, budget);
        explorations.push({ method: "getKeyframePtr", args: `(${timeLabel})`, ok: true, ...dump });
      } else {
        explorations.push({
          method: "getKeyframePtr",
          args: `(${timeLabel})`,
          ok: false,
          timedOut: Boolean(ptrResult.timedOut),
          error: ptrResult.timedOut ? "timed out" : String(ptrResult.error?.message || ptrResult.error || "returned null/undefined"),
        });
      }
    }
  } else {
    explorations.push({ method: "getKeyframePtr", ok: false, error: "not present on this ComponentParam" });
  }

  const hasAtTime = safe(() => typeof param.getKeyframeAtTime).value === "function";
  log(`[exploreKeyframe] getKeyframeAtTime: typeof=${hasAtTime ? "function" : "undefined"}`, "info");
  if (hasAtTime) {
    const timeCandidates = keyframeTimes.map((t, i) => ({ label: `enumerated keyframe time [${i}]`, time: t }));
    const zeroResult = await safeResolve(() => ppro.TickTime.createWithSeconds(0), { log, label: "TickTime.createWithSeconds(0)" });
    if (zeroResult.ok) timeCandidates.push({ label: "TickTime.createWithSeconds(0)", time: zeroResult.value });
    const inPointResult = await safeResolve(() => trackItem.getInPoint(), { log, label: "trackItem.getInPoint()" });
    if (inPointResult.ok) timeCandidates.push({ label: "trackItem.getInPoint()", time: inPointResult.value });

    for (const { label: timeLabel, time } of timeCandidates) {
      if (budget && budget.isExpired()) break;
      // eslint-disable-next-line no-await-in-loop
      const atTimeResult = await safeResolve(() => param.getKeyframeAtTime(time), { log, label: `getKeyframeAtTime(${timeLabel})`, timeoutMs: PROBE_CALL_TIMEOUT_MS });
      if (atTimeResult.ok && atTimeResult.value !== null && atTimeResult.value !== undefined) {
        // eslint-disable-next-line no-await-in-loop
        const dump = await dumpKeyframeObjectShape(atTimeResult.value, `getKeyframeAtTime(${timeLabel})`, log, budget);
        explorations.push({ method: "getKeyframeAtTime", args: `(${timeLabel})`, ok: true, ...dump });
      } else {
        explorations.push({
          method: "getKeyframeAtTime",
          args: `(${timeLabel})`,
          ok: false,
          timedOut: Boolean(atTimeResult.timedOut),
          error: atTimeResult.timedOut ? "timed out" : String(atTimeResult.error?.message || atTimeResult.error || "returned null/undefined"),
        });
      }
    }
  } else {
    explorations.push({ method: "getKeyframeAtTime", ok: false, error: "not present on this ComponentParam" });
  }

  const workingExploration = explorations.find((e) => e.ok && e.resolvedValue !== null && e.resolvedValue !== undefined);

  if (workingExploration) {
    log(
      `✓ Extracted a value via ${workingExploration.method}${workingExploration.args} → ${workingExploration.workingField}: ${JSON.stringify(workingExploration.resolvedValue)}`,
      "success"
    );
  } else {
    log("✗ No keyframe exploration path returned a usable value.", "warn");
  }

  return {
    keyframeList: { ok: listOk, count: keyframeTimes.length, error: listError },
    explorations,
    workingMethod: workingExploration ? `${workingExploration.method}${workingExploration.args}` : null,
    workingField: workingExploration ? workingExploration.workingField : null,
    resolvedValue: workingExploration ? workingExploration.resolvedValue : null,
  };
}

export const WRITE_PROBE_SENTINEL = "__KERIS_WRITE_TEST__";
const WRITE_PROBE_SETTLE_DELAY_MS = 500;

/**
 * Write-only probe: after every read-side avenue (getValue/.value/
 * getStartValue/reflection-discovered getters/getValueAtTime, then the
 * keyframe API — getKeyframeListAsTickTimes/getKeyframePtr/
 * getKeyframeAtTime) came back empty, this stops reverse-engineering reads
 * entirely and tests ONE thing: does `createSetValueAction()` accept the
 * sentinel string DIRECTLY — no `createKeyframe()` call at all, since that
 * throws "Illegal Parameter type" for a param reporting
 * `areKeyframesSupported: false` (confirmed two diagnostics ago). Never
 * reads the param's value before writing.
 *
 * After the transaction: reacquires the TrackItem's component chain and
 * the Source Text param completely fresh (never reusing pre-write
 * references), then makes ONE best-effort automated read-back attempt
 * (reusing `readSourceTextValueOnly()` — not new read-API exploration,
 * just checking whether the write itself happened to make the param
 * readable). That check is explicitly NOT treated as authoritative: if
 * the write API reports success but the automated check can't confirm a
 * visible change, this is reported as its own distinct outcome
 * (`write-api-succeeded-visible-change-unconfirmed`) rather than silently
 * assumed to mean success OR failure — a human visually checking the
 * Premiere timeline during the brief settle window is the only fully
 * reliable signal this diagnostic can point you toward.
 *
 * @param {Object} args
 * @param {import("@adobe/premierepro").Project} args.project
 * @param {import("@adobe/premierepro").TrackItem} args.trackItem
 * @param {number} args.componentIndex
 * @param {number} args.paramIndex
 * @param {*} args.param
 * @param {string} args.displayName
 * @param {string} args.sentinel
 * @param {(message: string, level?: string) => void} args.log
 * @param {ReturnType<typeof createScanBudget>} [args.budget]
 * @param {*} args.ppro
 */
export async function runWriteOnlyProbe({ project, trackItem, componentIndex, paramIndex, param, displayName, sentinel, log, budget, ppro }) {
  log(`[stage] write-only probe (component ${componentIndex}, param ${paramIndex}) — no read attempted before writing…`, "info");

  const argumentType = typeof sentinel;
  log(`[writeOnlyProbe] createSetValueAction argument: value=${JSON.stringify(sentinel)}, typeof=${argumentType} (passed directly — no createKeyframe call)`, "info");

  const actionResult = await safeResolve(() => param.createSetValueAction(sentinel, true), {
    log,
    label: "createSetValueAction(sentinel, true) [raw string, no createKeyframe]",
    timeoutMs: PROBE_CALL_TIMEOUT_MS,
  });

  if (!actionResult.ok) {
    const error = actionResult.timedOut ? "timed out" : String(actionResult.error?.message || actionResult.error);
    log(`✗ createSetValueAction(sentinel, true) failed: ${error}${actionResult.error?.stack ? `\n${actionResult.error.stack}` : ""}`, "error");
    return {
      componentIndex,
      paramIndex,
      displayName,
      write: { argumentType, ok: false, error },
      transaction: { attempted: false, ok: false },
      postWrite: null,
      outcome: "write-action-failed",
    };
  }

  const constructorResult = await safeResolve(() => actionResult.value?.constructor?.name, { log, label: "createSetValueAction(...).constructor" });
  const actionConstructorName = (constructorResult.ok && constructorResult.value) || null;
  log(`✓ createSetValueAction(sentinel, true) succeeded (constructor: ${actionConstructorName ?? "n/a"}).`, "success");

  log("[stage] executing the set-value transaction on the temporary clip…", "info");
  const transaction = runTransaction(project, actionResult.value, displayName, log, `Write-only probe: ${displayName ?? "Source Text"}`);

  if (!transaction.ok) {
    log("✗ Transaction did not succeed — the write probe cannot verify anything further.", "warn");
    return {
      componentIndex,
      paramIndex,
      displayName,
      write: { argumentType, ok: true, actionConstructorName },
      transaction,
      postWrite: null,
      outcome: "transaction-failed",
    };
  }

  log(`[stage] waiting ${WRITE_PROBE_SETTLE_DELAY_MS}ms for Premiere to apply the transaction…`, "info");
  await new Promise((resolve) => setTimeout(resolve, WRITE_PROBE_SETTLE_DELAY_MS));

  log("[stage] reacquiring the component chain and Source Text param from scratch (no stale references)…", "info");
  const chainResult = await safeResolve(() => trackItem.getComponentChain(), { log, label: "getComponentChain() (write probe reacquire)" });
  if (!chainResult.ok || !chainResult.value) {
    log("✗ Couldn't reacquire the component chain after the write.", "warn");
    return {
      componentIndex,
      paramIndex,
      displayName,
      write: { argumentType, ok: true, actionConstructorName },
      transaction,
      postWrite: { reacquired: false, error: "couldn't reacquire the component chain" },
      outcome: "write-succeeded-reacquire-failed",
    };
  }
  const { textInfo } = await locateTextComponent(chainResult.value, log);
  if (!textInfo) {
    log("✗ AE.ADBE Text component not found on the reacquired chain.", "warn");
    return {
      componentIndex,
      paramIndex,
      displayName,
      write: { argumentType, ok: true, actionConstructorName },
      transaction,
      postWrite: { reacquired: false, error: "AE.ADBE Text component not found on the reacquired chain" },
      outcome: "write-succeeded-reacquire-failed",
    };
  }
  const located = await locateSourceTextParam(textInfo.component, textInfo.componentIndex, log);
  if (!located) {
    log("✗ Source Text param not found on the reacquired component.", "warn");
    return {
      componentIndex,
      paramIndex,
      displayName,
      write: { argumentType, ok: true, actionConstructorName },
      transaction,
      postWrite: { reacquired: false, error: "Source Text param not found on the reacquired component" },
      outcome: "write-succeeded-reacquire-failed",
    };
  }

  log(
    "[stage] making ONE best-effort automated read-back attempt — NOT a confirmed reliable signal (see the earlier read/keyframe " +
      "diagnostics); a human visually checking the Premiere timeline right now is the only way to be certain…",
    "info"
  );
  const bestEffortRead = await readSourceTextValueOnly(located.param, ppro, trackItem, log, budget);
  const automatedCheckConfirmsChange = bestEffortRead.resolvedValue === sentinel;

  if (automatedCheckConfirmsChange) {
    log(`✓ Best-effort automated read-back ALSO confirms the change (via ${bestEffortRead.workingMethod}()).`, "success");
  } else {
    log(
      "⚠ The write API reported success, but the best-effort automated read-back could not confirm the visible text actually " +
        "changed. This does NOT necessarily mean the write failed — it may only mean there is still no reliable read path. " +
        "Reported separately below rather than assumed either way.",
      "warn"
    );
  }

  return {
    componentIndex,
    paramIndex,
    displayName,
    write: { argumentType, ok: true, actionConstructorName },
    transaction,
    postWrite: {
      reacquired: true,
      componentIndex: textInfo.componentIndex,
      paramIndex: located.paramIndex,
      bestEffortRead,
      automatedCheckConfirmsChange,
    },
    manualVisualConfirmationNeeded: !automatedCheckConfirmsChange,
    outcome: automatedCheckConfirmsChange ? "write-succeeded-and-confirmed" : "write-api-succeeded-visible-change-unconfirmed",
  };
}

/**
 * Reads whatever metadata is actually available on the ComponentParam
 * itself — Part B's "value type / param type / data type / class name /
 * matchName / serialization hints" — before attempting any value-shape
 * candidate. Purely observational, never mutating.
 */
async function inspectParamMetadata(param, log, budget) {
  const shape = await probeObjectShape(param, "sourceTextParam (metadata)", log, budget);
  const candidateFieldNames = ["type", "paramType", "dataType", "valueType", "matchName"];
  const fields = {};
  for (const name of candidateFieldNames) {
    const raw = safe(() => param[name]);
    if (!raw.ok) {
      fields[name] = { present: false };
      continue;
    }
    fields[name] = { present: raw.value !== undefined, typeofValue: typeof raw.value, summary: raw.value !== undefined ? summarizeHostValue(raw.value) : null };
  }
  const jsonResult = safe(() => JSON.stringify(param));
  log(
    `[probeValueShapes] param metadata — constructor=${shape.constructorName ?? "n/a"}, ` +
      `fields checked: ${candidateFieldNames.map((n) => `${n}=${fields[n].present ? "present" : "absent"}`).join(", ")}, ` +
      `JSON.stringify ${jsonResult.ok ? "succeeded" : `threw (${jsonResult.error.message || jsonResult.error})`}`,
    "info"
  );
  return {
    constructorName: shape.constructorName,
    prototypeMethodNames: shape.prototypeMethodNames,
    prototypeNonMethodNames: shape.prototypeNonMethodNames,
    fields,
    jsonSerialization: jsonResult.ok ? jsonResult.value : null,
    jsonSerializationError: jsonResult.ok ? null : String(jsonResult.error.message || jsonResult.error),
  };
}

/**
 * Fetches an existing Keyframe object via `getKeyframePtr(TickTime)` —
 * CONFIRMED (Adobe's official docs) to take a TickTime, not an index —
 * for candidate 3 below: mutating its documented-Writable `.value`
 * property directly, sidestepping `createKeyframe()`'s "compatible with
 * the component param type" check (the confirmed source of "Illegal
 * Parameter type" for a bare string on this param).
 */
async function fetchExistingKeyframeObject(param, ppro, log) {
  if (safe(() => typeof param.getKeyframePtr).value !== "function") {
    return { ok: false, error: "getKeyframePtr not present on this ComponentParam" };
  }
  const timeResult = await safeResolve(() => ppro.TickTime.createWithSeconds(0), { log, label: "TickTime.createWithSeconds(0) (value-shapes probe)" });
  if (!timeResult.ok) {
    return { ok: false, error: "couldn't construct a TickTime" };
  }
  const ptrResult = await safeResolve(() => param.getKeyframePtr(timeResult.value), { log, label: "getKeyframePtr(0) (value-shapes probe)", timeoutMs: PROBE_CALL_TIMEOUT_MS });
  if (!ptrResult.ok || ptrResult.value === null || ptrResult.value === undefined) {
    return { ok: false, error: ptrResult.timedOut ? "timed out" : String(ptrResult.error?.message || ptrResult.error || "returned null/undefined") };
  }
  return { ok: true, value: ptrResult.value };
}

/**
 * Attempts `param.createSetValueAction(value, true)` for exactly one
 * candidate value shape, logging the shape tried and the host's exact
 * response (success + action constructor, or the full thrown error).
 * Never executes the resulting action — that's the caller's job, only for
 * whichever candidate(s) actually succeed at construction.
 */
async function tryCreateSetValueActionCandidate(param, candidateName, buildValue, log, budget) {
  if (budget && budget.isExpired()) return { name: candidateName, attempted: false, ok: false, skipped: true, reason: budget.reason() };

  const valueResult = safe(buildValue);
  if (!valueResult.ok || valueResult.value === undefined) {
    const reason = valueResult.ok ? "buildValue returned undefined" : String(valueResult.error.message || valueResult.error);
    log(`[probeValueShapes] ${candidateName}: couldn't build this candidate value (${reason}) — skipping.`, "warn");
    return { name: candidateName, attempted: false, ok: false, error: reason };
  }
  const value = valueResult.value;
  const valueSummary = summarizeHostValue(value);
  log(`[probeValueShapes] trying ${candidateName} — value shape: ${JSON.stringify(valueSummary)}`, "info");

  const actionResult = await safeResolve(() => param.createSetValueAction(value, true), {
    log,
    label: `createSetValueAction(${candidateName}, true)`,
    timeoutMs: PROBE_CALL_TIMEOUT_MS,
  });
  if (!actionResult.ok) {
    const error = actionResult.timedOut ? "timed out" : String(actionResult.error?.message || actionResult.error);
    log(`✗ ${candidateName}: createSetValueAction threw: ${error}`, "warn");
    return { name: candidateName, attempted: true, ok: false, valueSummary, error };
  }
  const constructorResult = await safeResolve(() => actionResult.value?.constructor?.name, { log, label: `createSetValueAction(${candidateName}).constructor` });
  const actionConstructorName = (constructorResult.ok && constructorResult.value) || null;
  log(`✓ ${candidateName}: createSetValueAction SUCCEEDED (constructor: ${actionConstructorName ?? "n/a"}).`, "success");
  return { name: candidateName, attempted: true, ok: true, valueSummary, action: actionResult.value, actionConstructorName };
}

/**
 * "Probe Source Text Value Shapes" — tests ONLY value shapes grounded in
 * Adobe's official ComponentParam/Keyframe/PointKeyframe documentation
 * (AdobeDocs/uxp-premiere-pro), never invented/random objects, per the
 * explicit task requirement. Grounding, verified against the current
 * public docs:
 *
 *   - `ComponentParam.createSetValueAction`'s documented `inValue` type is
 *     `number | string | boolean | PointF | Color` — no text/rich-text
 *     wrapper class is documented anywhere in the public reference.
 *   - `Keyframe.value` is documented as
 *     `{ value: string | number | boolean | Color | PointF }`, Writable.
 *   - `PointKeyframe.value` is documented as `{ value: PointF }` — a
 *     specialized subclass exists per value KIND, following the same
 *     `{ value: X }` wrapper shape.
 *   - `getKeyframePtr(tickTime)` is documented to return the Keyframe at a
 *     given TickTime.
 *
 * Three candidates follow directly from this, and only these three:
 *
 *   1. Raw string — the documented `inValue` type. Already confirmed to
 *      throw "Illegal Parameter type" on a real host for this param;
 *      re-tried here for one complete, consolidated record.
 *   2. `{ value: sentinel }` — the documented Keyframe/PointKeyframe
 *      wrapper SHAPE, tried directly as `inValue` in case the same
 *      wrapper form `createSetValueAction` ultimately serializes a
 *      Keyframe's `.value` into is also accepted directly.
 *   3. An EXISTING Keyframe object (via `getKeyframePtr`), with its
 *      documented-Writable `.value` mutated to the sentinel, then passed
 *      as `inValue` directly — sidesteps `createKeyframe()`'s "compatible
 *      with the component param type" check entirely.
 *
 * For whichever candidate(s) successfully construct an action (i.e. the
 * host accepted the value's type), the FIRST such candidate is also
 * executed via `runTransaction()` and given one best-effort automated
 * read-back check (reusing `readSourceTextValueOnly()`), so a viable
 * shape is fully verified, not just "didn't throw at construction time".
 *
 * @param {Object} args
 * @param {import("@adobe/premierepro").Project} args.project
 * @param {import("@adobe/premierepro").TrackItem} args.trackItem
 * @param {*} args.param
 * @param {string} args.displayName
 * @param {string} args.sentinel
 * @param {(message: string, level?: string) => void} args.log
 * @param {ReturnType<typeof createScanBudget>} [args.budget]
 * @param {*} args.ppro
 */
export async function probeSourceTextValueShapes({ project, trackItem, param, displayName, sentinel, log, budget, ppro }) {
  log("[stage] probing Source Text value shapes — ONLY candidates grounded in Adobe's official docs, never random objects…", "info");

  const metadata = await inspectParamMetadata(param, log, budget);

  const candidates = [];
  candidates.push(
    await tryCreateSetValueActionCandidate(param, "raw string (documented createSetValueAction inValue type)", () => sentinel, log, budget)
  );
  candidates.push(
    await tryCreateSetValueActionCandidate(
      param,
      "{ value: sentinel } (Keyframe.value's documented wrapper shape)",
      () => ({ value: sentinel }),
      log,
      budget
    )
  );

  const existingKeyframe = await fetchExistingKeyframeObject(param, ppro, log);
  if (existingKeyframe.ok) {
    candidates.push(
      await tryCreateSetValueActionCandidate(
        param,
        "existing Keyframe (getKeyframePtr) with .value mutated directly (documented Writable)",
        () => {
          const kf = existingKeyframe.value;
          const setResult = safe(() => {
            kf.value = sentinel;
          });
          return setResult.ok ? kf : undefined;
        },
        log,
        budget
      )
    );
  } else {
    log(`[probeValueShapes] couldn't obtain an existing Keyframe via getKeyframePtr — skipping candidate 3: ${existingKeyframe.error}`, "warn");
    candidates.push({
      name: "existing Keyframe (getKeyframePtr) with .value mutated directly (documented Writable)",
      attempted: false,
      ok: false,
      error: existingKeyframe.error,
    });
  }

  const workingCandidate = candidates.find((c) => c.ok);
  let verifiedWrite = null;

  if (workingCandidate) {
    log(`[stage] "${workingCandidate.name}" constructed an action successfully — executing the transaction to verify…`, "info");
    const transaction = runTransaction(project, workingCandidate.action, displayName, log, `Probe Source Text value shapes (${workingCandidate.name})`);
    if (transaction.ok) {
      await new Promise((resolve) => setTimeout(resolve, READ_BACK_SETTLE_DELAY_MS));
      // Reacquire fresh — never reuse the pre-write Component/ComponentParam
      // reference, same discipline as every other write-verification path
      // in this module (readBackSourceText, runWriteOnlyProbe).
      const chainResult = await safeResolve(() => trackItem.getComponentChain(), { log, label: "getComponentChain() (value-shapes probe reacquire)" });
      const freshTextInfo = chainResult.ok && chainResult.value ? (await locateTextComponent(chainResult.value, log)).textInfo : null;
      const freshLocated = freshTextInfo ? await locateSourceTextParam(freshTextInfo.component, freshTextInfo.componentIndex, log) : null;
      if (freshLocated) {
        const bestEffortRead = await readSourceTextValueOnly(freshLocated.param, ppro, trackItem, log, budget);
        verifiedWrite = { transaction, automatedCheckConfirmsChange: bestEffortRead.resolvedValue === sentinel, bestEffortRead };
      } else {
        log("✗ Couldn't reacquire Source Text fresh after the write — automated check skipped.", "warn");
        verifiedWrite = { transaction, automatedCheckConfirmsChange: false, bestEffortRead: null, reacquireFailed: true };
      }
    } else {
      verifiedWrite = { transaction, automatedCheckConfirmsChange: false, bestEffortRead: null };
    }
  }

  // Strip live host handles before returning a JSON-safe report.
  const candidatesSafe = candidates.map(({ action: _action, ...rest }) => rest);

  if (workingCandidate) {
    log(
      verifiedWrite?.automatedCheckConfirmsChange
        ? `✓ Found a working Source Text value shape: "${workingCandidate.name}" — transaction executed and the automated check confirms it.`
        : `⚠ "${workingCandidate.name}" constructed and executed a transaction, but the automated check couldn't confirm the visible change.`,
      verifiedWrite?.automatedCheckConfirmsChange ? "success" : "warn"
    );
  } else {
    log(
      "✗ None of the documented value shapes were accepted by createSetValueAction for this param. Per Adobe's public reference, no " +
        "text/rich-text wrapper type is documented for ComponentParam at all — if none of these three grounded candidates work, this " +
        "strongly suggests writing native Premiere MOGRT Source Text is not currently supported through the documented UXP scripting API.",
      "error"
    );
  }

  return {
    metadata,
    candidates: candidatesSafe,
    workingCandidateName: workingCandidate ? workingCandidate.name : null,
    verifiedWrite,
  };
}

/**
 * Non-mutating: constructs a Keyframe from the sentinel string via
 * `param.createKeyframe(sentinel)`. Per the official API this is
 * documented to only build a local Keyframe object — it does not touch
 * the sequence — so it's always safe to attempt regardless of what
 * happens afterward.
 */
export async function testKeyframeCreation(param, sentinel, log, budget) {
  if (budget && budget.isExpired()) return { ok: false, skipped: true, reason: budget.reason() };

  const result = await safeResolve(() => param.createKeyframe(sentinel), {
    log,
    label: "createKeyframe(sentinel)",
    timeoutMs: PROBE_CALL_TIMEOUT_MS,
  });
  if (!result.ok) {
    return {
      ok: false,
      timedOut: Boolean(result.timedOut),
      error: result.timedOut ? "timed out" : String(result.error?.message || result.error),
    };
  }

  const keyframe = result.value;
  const constructorResult = await safeResolve(() => keyframe?.constructor?.name, { log, label: "createKeyframe(sentinel).constructor" });
  const constructorName = (constructorResult.ok && constructorResult.value) || null;
  const rawSummary = summarizeHostValue(keyframe);
  const resolvedValue = await unwrapValueDeep(keyframe, log, { label: "createKeyframe(sentinel)" });

  return {
    ok: true,
    keyframe,
    constructorName,
    rawSummary,
    resolvedValue,
    sentinelPreserved: resolvedValue === sentinel,
  };
}

/** Only reached if keyframe construction succeeded. */
export async function testActionCreation(param, keyframe, log, budget) {
  if (budget && budget.isExpired()) return { attempted: false, ok: false, skipped: true, reason: budget.reason() };

  const result = await safeResolve(() => param.createSetValueAction(keyframe, true), {
    log,
    label: "createSetValueAction(keyframe, true)",
    timeoutMs: PROBE_CALL_TIMEOUT_MS,
  });
  if (!result.ok) {
    return {
      attempted: true,
      ok: false,
      timedOut: Boolean(result.timedOut),
      error: result.timedOut ? "timed out" : String(result.error?.message || result.error),
    };
  }
  const constructorResult = await safeResolve(() => result.value?.constructor?.name, { log, label: "createSetValueAction(...).constructor" });
  return { attempted: true, ok: true, action: result.value, constructorName: (constructorResult.ok && constructorResult.value) || null };
}

/**
 * Executes the set-value action through the active project's locked-
 * access + executeTransaction/CompoundAction mechanism — the exact same
 * pattern src/ppro/componentParams.js's setParamValue() uses for every
 * other param write in this extension, applied here to the TEMPORARY
 * diagnostic clip only (guaranteed removed in cleanup regardless of
 * outcome). Synchronous, like every other executeTransaction call in this
 * codebase — not timeout-wrapped, since none of the established call
 * sites await it either.
 */
export function runTransaction(project, action, paramLabel, log, transactionLabel) {
  log(`[transaction] executeTransaction — label: "${transactionLabel ?? `Diagnostic Source Text round trip (${paramLabel ?? "Source Text"})`}"`, "info");
  let success = false;
  let error = null;
  try {
    project.lockedAccess(() => {
      success = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(action);
      }, transactionLabel ?? `Diagnostic Source Text round trip (${paramLabel ?? "Source Text"})`);
    });
    log(`[transaction] executeTransaction result: ${success}`, success ? "success" : "warn");
  } catch (err) {
    error = String(err.message || err);
    log(`✗ executeTransaction threw: ${error}${err.stack ? `\n${err.stack}` : ""}`, "error");
  }
  return { attempted: true, ok: success && !error, error };
}

/**
 * Reacquires everything fresh after the transaction — a new
 * `getComponentChain()`, a newly-located AE.ADBE Text component, and a
 * newly-located Source Text param, none of them reused from before the
 * write. Waits briefly first (Premiere may need a moment to apply the
 * transaction before the change is visible to a fresh read).
 */
export async function readBackSourceText(trackItem, ppro, sentinel, log, budget) {
  if (budget && budget.isExpired()) return { attempted: false, ok: false, skipped: true, reason: budget.reason() };

  await new Promise((resolve) => setTimeout(resolve, READ_BACK_SETTLE_DELAY_MS));

  const chainResult = await safeResolve(() => trackItem.getComponentChain(), { log, label: "getComponentChain() (read-back)" });
  if (!chainResult.ok || !chainResult.value) {
    return { attempted: true, ok: false, error: "couldn't reacquire the component chain for read-back" };
  }
  const { textInfo } = await locateTextComponent(chainResult.value, log);
  if (!textInfo) {
    return { attempted: true, ok: false, error: "AE.ADBE Text component not found on the reacquired chain" };
  }
  const located = await locateSourceTextParam(textInfo.component, textInfo.componentIndex, log);
  if (!located) {
    return { attempted: true, ok: false, error: "Source Text param not found on the reacquired component", componentIndex: textInfo.componentIndex };
  }

  const timeResult = await safeResolve(() => ppro.TickTime.createWithSeconds(0), { log, label: "TickTime.createWithSeconds(0) (read-back)" });
  if (!timeResult.ok) {
    return { attempted: true, ok: false, error: "couldn't construct a TickTime for read-back", componentIndex: textInfo.componentIndex, paramIndex: located.paramIndex };
  }
  const valueResult = await safeResolve(() => located.param.getValueAtTime(timeResult.value), {
    log,
    label: "getValueAtTime(0) (read-back)",
    timeoutMs: PROBE_CALL_TIMEOUT_MS,
  });
  if (!valueResult.ok) {
    return {
      attempted: true,
      ok: false,
      timedOut: Boolean(valueResult.timedOut),
      error: valueResult.timedOut ? "timed out" : String(valueResult.error?.message || valueResult.error),
      componentIndex: textInfo.componentIndex,
      paramIndex: located.paramIndex,
    };
  }

  const rawSummary = summarizeHostValue(valueResult.value);
  const resolvedValue = await unwrapValueDeep(valueResult.value, log, { label: "getValueAtTime(0) (read-back)" });
  return {
    attempted: true,
    ok: true,
    matched: resolvedValue === sentinel,
    resolvedValue,
    rawSummary,
    componentIndex: textInfo.componentIndex,
    paramIndex: located.paramIndex,
  };
}

/**
 * Orchestrates the whole round trip for an already-located Source Text
 * param: read attempts, non-mutating keyframe construction, (only if that
 * succeeded) a real set-value action + transaction on the temporary clip,
 * and (only if that succeeded) a fresh reacquire-and-read-back. Every step
 * is independently recorded — a failure partway through still returns a
 * full report of everything that DID complete, rather than an all-or-
 * nothing result.
 *
 * @param {Object} args
 * @param {import("@adobe/premierepro").Project} args.project
 * @param {import("@adobe/premierepro").TrackItem} args.trackItem
 * @param {number} args.componentIndex
 * @param {number} args.paramIndex
 * @param {*} args.param
 * @param {string} args.displayName
 * @param {boolean|null} args.isTimeVarying
 * @param {boolean|null} args.areKeyframesSupported
 * @param {string} args.sentinel
 * @param {(message: string, level?: string) => void} args.log
 * @param {ReturnType<typeof createScanBudget>} args.budget
 * @param {*} args.ppro The `premierepro` host module (e.g. from getPpro()) — passed in rather than
 *   fetched internally so this function stays testable with a fake host outside a live Premiere process.
 */
export async function runSourceTextRoundTrip({
  project,
  trackItem,
  componentIndex,
  paramIndex,
  param,
  displayName,
  isTimeVarying,
  areKeyframesSupported,
  sentinel,
  log,
  budget,
  ppro,
}) {
  log(`[stage] testing Source Text round trip (component ${componentIndex}, param ${paramIndex})…`, "info");

  const valueRead = await readSourceTextValueOnly(param, ppro, trackItem, log, budget);

  // Never call createKeyframe when the param has told us keyframes aren't
  // supported — confirmed real-host behavior: doing so anyway throws
  // "Illegal Parameter type" instead of constructing anything. Only skip on
  // a confirmed `false`; if the flag couldn't be read (null/undefined), still
  // attempt it as before rather than assuming.
  let keyframeCreation;
  if (areKeyframesSupported === false) {
    log(
      '[stage] skipping createKeyframe — this param reports areKeyframesSupported:false, so constructing a keyframe for it is not applicable ' +
        '(confirmed real-host: throws "Illegal Parameter type" instead).',
      "warn"
    );
    keyframeCreation = { ok: false, skipped: true, reason: "areKeyframesSupported is false" };
  } else {
    log("[stage] testing non-mutating keyframe construction (createKeyframe, no sequence change)…", "info");
    keyframeCreation = await testKeyframeCreation(param, sentinel, log, budget);
  }

  let actionCreation = { attempted: false, ok: false };
  let transaction = { attempted: false, ok: false };
  let readBack = { attempted: false, ok: false };

  if (keyframeCreation.ok) {
    log("[stage] creating a set-value action from the sentinel keyframe…", "info");
    actionCreation = await testActionCreation(param, keyframeCreation.keyframe, log, budget);

    if (actionCreation.ok) {
      log("[stage] executing the set-value action on the temporary clip…", "info");
      transaction = runTransaction(project, actionCreation.action, displayName, log);

      if (transaction.ok) {
        log("[stage] reacquiring the component chain and reading back the sentinel…", "info");
        readBack = await readBackSourceText(trackItem, ppro, sentinel, log, budget);
      } else {
        log("✗ Transaction did not succeed — skipping read-back.", "warn");
      }
    } else {
      log(`✗ Source Text write action could not be created: ${actionCreation.error ?? "unknown error"}`, "warn");
    }
  } else if (!keyframeCreation.skipped) {
    log(`✗ createKeyframe(sentinel) failed — skipping action/transaction/read-back: ${keyframeCreation.error ?? "unknown error"}`, "warn");
  }

  // Strip live host handles before returning a JSON-safe report.
  const { keyframe: _keyframe, ...keyframeCreationSafe } = keyframeCreation;
  const { action: _action, ...actionCreationSafe } = actionCreation;

  return {
    componentIndex,
    paramIndex,
    displayName,
    isTimeVarying,
    areKeyframesSupported,
    valueRead,
    keyframeCreation: keyframeCreationSafe,
    actionCreation: actionCreationSafe,
    transaction,
    readBack,
  };
}

// Single in-flight round trip's cancel token — same cooperative-cancel
// pattern as diagnostics.js's activeCancelToken, kept separate since this
// is a different operation that can run independently.
let activeCancelToken = null;

export function cancelActiveSourceTextRoundTrip() {
  if (activeCancelToken) {
    activeCancelToken.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Full entry point: insert a temporary clip, wait for its component chain
 * to stabilize (see stabilizeComponentChain() in diagnostics.js), locate
 * Source Text, run the round trip, clean up the temporary clip (always,
 * whether any step above threw, failed, timed out, or was cancelled), and
 * return a JSON-safe report. Does NOT run the generic classification
 * report or raw probe — this is deliberately the narrow, fast path.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {string} [opts.sentinel]
 * @param {number} [opts.scanBudgetMs]
 */
export async function testSourceTextRoundTrip(opts) {
  const { mogrtPath, log, sentinel = DEFAULT_SENTINEL, scanBudgetMs = DEFAULT_ROUND_TRIP_BUDGET_MS } = opts;

  log("════ Source Text Round Trip — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const cancelToken = { cancelled: false };
  activeCancelToken = cancelToken;

  try {
    let project, sequence;
    try {
      ({ project, sequence } = await requireActiveProjectAndSequence());
    } catch (err) {
      log(`✗ No active project/sequence: ${err.message || err}`, "error");
      return { ok: false, step: "sequence" };
    }

    const tracksResult = await safeAsync(() => listVideoTracks(sequence));
    if (!tracksResult.ok || tracksResult.value.length === 0) {
      log(
        tracksResult.ok
          ? "✗ No video track available to insert a temporary inspection clip onto."
          : `✗ listVideoTracks() threw: ${tracksResult.error.message || tracksResult.error}`,
        "error"
      );
      return { ok: false, step: "track" };
    }
    const videoTrackIndex = tracksResult.value[tracksResult.value.length - 1].index;

    const startSec = await resolveInsertionTimeSec(sequence, log);

    log(`[stage] inserting clip from: ${mogrtPath}`, "info");
    const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log));
    if (!insertResult.ok) {
      log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
      return { ok: false, step: "insert" };
    }
    const trackItem = insertResult.value;
    log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

    const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
      async () => {
        log("[stage] waiting for MOGRT components to finish initializing…", "info");
        const stabilization = await stabilizeComponentChain(trackItem, log, { cancelToken });
        const textInfo = stabilization.discovery.components.find((c) => c.classification === "text-editing");

        if (!textInfo) {
          log(`${MOGRT_INIT_TIMEOUT_MESSAGE} No AE.ADBE Text component found — cannot test Source Text this run.`, "warn");
          return { found: false, reason: "no-text-component", componentDiscoveryTimeline: stabilization.timeline };
        }

        log(
          `[stage] AE.ADBE Text found at index ${textInfo.componentIndex} — locating Source Text by displayName (index kept only as metadata)…`,
          "info"
        );
        const located = await locateSourceTextParam(textInfo.component, textInfo.componentIndex, log);
        if (!located) {
          log('✗ No param with displayName exactly "Source Text" was found on the AE.ADBE Text component.', "error");
          return {
            found: false,
            reason: "no-source-text-param",
            componentDiscoveryTimeline: stabilization.timeline,
            componentIndex: textInfo.componentIndex,
          };
        }

        const isTimeVaryingResult =
          typeof located.param.isTimeVarying === "function"
            ? await safeResolve(() => located.param.isTimeVarying(), { log, label: "sourceText.isTimeVarying()" })
            : { ok: false };
        const areKeyframesSupportedResult =
          typeof located.param.areKeyframesSupported === "function"
            ? await safeResolve(() => located.param.areKeyframesSupported(), { log, label: "sourceText.areKeyframesSupported()" })
            : { ok: false };

        const probeBudget = createScanBudget({ totalMs: scanBudgetMs, cancelToken });
        const sourceTextProbe = await runSourceTextRoundTrip({
          project,
          trackItem,
          componentIndex: textInfo.componentIndex,
          paramIndex: located.paramIndex,
          param: located.param,
          displayName: located.displayName,
          isTimeVarying: isTimeVaryingResult.ok ? isTimeVaryingResult.value : null,
          areKeyframesSupported: areKeyframesSupportedResult.ok ? areKeyframesSupportedResult.value : null,
          sentinel,
          log,
          budget: probeBudget,
          ppro: getPpro(),
        });

        log("[stage] serializing results…", "info");
        return { found: true, sourceTextProbe, componentDiscoveryTimeline: stabilization.timeline };
      },
      () => {
        log("[stage] cleaning up (removing temporary inspection clip)…", "info");
        return safeAsync(() => removeTrackItem(project, sequence, trackItem));
      },
      log
    );

    const cleanupOk = cleanupResult.ok && cleanupResult.value === true;
    if (cleanupResult.ok && cleanupResult.value) {
      log("Removed temporary inspection clip.", "info");
    } else {
      log(
        `Couldn't remove the temporary inspection clip (${
          cleanupResult.ok ? "transaction reported failure" : cleanupResult.error.message || cleanupResult.error
        }) — you may need to delete it from the timeline by hand.`,
        "warn"
      );
    }

    if (scanError) {
      log("════ Source Text Round Trip — finished with errors (cleanup still ran) ════", "error");
      return {
        ok: false,
        step: "scan",
        error: String(scanError.message || scanError),
        cleanupOk,
        componentDiscoveryTimeline: [],
      };
    }

    const report = scanReport ?? { found: false, reason: "crash", componentDiscoveryTimeline: [] };

    if (!report.found) {
      log("════ Source Text Round Trip — finished (Source Text not found this run) ════", "warn");
      return {
        ok: true,
        found: false,
        reason: report.reason,
        componentDiscoveryTimeline: report.componentDiscoveryTimeline,
        cleanupOk,
      };
    }

    const sourceTextProbe = { ...report.sourceTextProbe, cleanupOk };
    const success = Boolean(sourceTextProbe.readBack?.ok && sourceTextProbe.readBack?.matched);
    log(
      success
        ? "════ Source Text Round Trip — finished: SUCCESS (sentinel written and read back) ════"
        : "════ Source Text Round Trip — finished (round trip did not fully succeed — see sourceTextProbe for details) ════",
      success ? "success" : "warn"
    );

    return {
      ok: true,
      found: true,
      sourceTextProbe,
      componentDiscoveryTimeline: report.componentDiscoveryTimeline,
      cleanupOk,
    };
  } finally {
    if (activeCancelToken === cancelToken) activeCancelToken = null;
  }
}

// Separate cancel-token slot from the full round trip's, since this is a
// distinct operation that can run independently (and the UI can only ever
// have one of the two running at a time, but they must not share state).
let activeReadOnlyCancelToken = null;

export function cancelActiveReadSourceTextOnly() {
  if (activeReadOnlyCancelToken) {
    activeReadOnlyCancelToken.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Dedicated READ-ONLY entry point, run BEFORE ever attempting a write (see
 * testSourceTextRoundTrip for the full read+write round trip): insert a
 * temporary clip, wait for its component chain to stabilize, locate Source
 * Text, read it via readSourceTextValueOnly() (never createKeyframe or
 * anything else that could mutate the sequence), clean up the temporary
 * clip (always, whether any step above threw, failed, timed out, or was
 * cancelled), and return a JSON-safe report.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {number} [opts.scanBudgetMs]
 */
export async function testReadSourceTextOnly(opts) {
  const { mogrtPath, log, scanBudgetMs = DEFAULT_ROUND_TRIP_BUDGET_MS } = opts;

  log("════ Read Source Text Only — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const cancelToken = { cancelled: false };
  activeReadOnlyCancelToken = cancelToken;

  try {
    let project, sequence;
    try {
      ({ project, sequence } = await requireActiveProjectAndSequence());
    } catch (err) {
      log(`✗ No active project/sequence: ${err.message || err}`, "error");
      return { ok: false, step: "sequence" };
    }

    const tracksResult = await safeAsync(() => listVideoTracks(sequence));
    if (!tracksResult.ok || tracksResult.value.length === 0) {
      log(
        tracksResult.ok
          ? "✗ No video track available to insert a temporary inspection clip onto."
          : `✗ listVideoTracks() threw: ${tracksResult.error.message || tracksResult.error}`,
        "error"
      );
      return { ok: false, step: "track" };
    }
    const videoTrackIndex = tracksResult.value[tracksResult.value.length - 1].index;

    const startSec = await resolveInsertionTimeSec(sequence, log);

    log(`[stage] inserting clip from: ${mogrtPath}`, "info");
    const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log));
    if (!insertResult.ok) {
      log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
      return { ok: false, step: "insert" };
    }
    const trackItem = insertResult.value;
    log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

    const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
      async () => {
        log("[stage] waiting for MOGRT components to finish initializing…", "info");
        const stabilization = await stabilizeComponentChain(trackItem, log, { cancelToken });
        const textInfo = stabilization.discovery.components.find((c) => c.classification === "text-editing");

        if (!textInfo) {
          log(`${MOGRT_INIT_TIMEOUT_MESSAGE} No AE.ADBE Text component found — cannot test Source Text this run.`, "warn");
          return { found: false, reason: "no-text-component", componentDiscoveryTimeline: stabilization.timeline };
        }

        log(`[stage] AE.ADBE Text found at index ${textInfo.componentIndex} — locating Source Text by displayName…`, "info");
        const located = await locateSourceTextParam(textInfo.component, textInfo.componentIndex, log);
        if (!located) {
          log('✗ No param with displayName exactly "Source Text" was found on the AE.ADBE Text component.', "error");
          return {
            found: false,
            reason: "no-source-text-param",
            componentDiscoveryTimeline: stabilization.timeline,
            componentIndex: textInfo.componentIndex,
          };
        }

        const isTimeVaryingResult =
          typeof located.param.isTimeVarying === "function"
            ? await safeResolve(() => located.param.isTimeVarying(), { log, label: "sourceText.isTimeVarying()" })
            : { ok: false };
        const areKeyframesSupportedResult =
          typeof located.param.areKeyframesSupported === "function"
            ? await safeResolve(() => located.param.areKeyframesSupported(), { log, label: "sourceText.areKeyframesSupported()" })
            : { ok: false };

        const probeBudget = createScanBudget({ totalMs: scanBudgetMs, cancelToken });
        const valueRead = await readSourceTextValueOnly(located.param, getPpro(), trackItem, log, probeBudget);

        return {
          found: true,
          componentIndex: textInfo.componentIndex,
          paramIndex: located.paramIndex,
          displayName: located.displayName,
          isTimeVarying: isTimeVaryingResult.ok ? isTimeVaryingResult.value : null,
          areKeyframesSupported: areKeyframesSupportedResult.ok ? areKeyframesSupportedResult.value : null,
          valueRead,
          componentDiscoveryTimeline: stabilization.timeline,
        };
      },
      () => {
        log("[stage] cleaning up (removing temporary inspection clip)…", "info");
        return safeAsync(() => removeTrackItem(project, sequence, trackItem));
      },
      log
    );

    const cleanupOk = cleanupResult.ok && cleanupResult.value === true;
    if (cleanupResult.ok && cleanupResult.value) {
      log("Removed temporary inspection clip.", "info");
    } else {
      log(
        `Couldn't remove the temporary inspection clip (${
          cleanupResult.ok ? "transaction reported failure" : cleanupResult.error.message || cleanupResult.error
        }) — you may need to delete it from the timeline by hand.`,
        "warn"
      );
    }

    if (scanError) {
      log("════ Read Source Text Only — finished with errors (cleanup still ran) ════", "error");
      return { ok: false, step: "scan", error: String(scanError.message || scanError), cleanupOk, componentDiscoveryTimeline: [] };
    }

    const report = scanReport ?? { found: false, reason: "crash", componentDiscoveryTimeline: [] };

    if (!report.found) {
      log("════ Read Source Text Only — finished (Source Text not found this run) ════", "warn");
      return { ok: true, found: false, reason: report.reason, componentDiscoveryTimeline: report.componentDiscoveryTimeline, cleanupOk };
    }

    const success = Boolean(report.valueRead?.resolvedValue !== null && report.valueRead?.resolvedValue !== undefined);
    log(
      success
        ? `════ Read Source Text Only — finished: SUCCESS via ${report.valueRead.workingMethod}() ════`
        : "════ Read Source Text Only — finished (no read method returned a value — see valueRead for details) ════",
      success ? "success" : "warn"
    );

    return { ok: true, found: true, ...report, cleanupOk };
  } finally {
    if (activeReadOnlyCancelToken === cancelToken) activeReadOnlyCancelToken = null;
  }
}

// Separate cancel-token slot from the other two entry points', for the
// same reason they're separate from each other.
let activeExploreKeyframeCancelToken = null;

export function cancelActiveExploreKeyframeObject() {
  if (activeExploreKeyframeCancelToken) {
    activeExploreKeyframeCancelToken.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Dedicated entry point for `exploreKeyframeObject()`: insert a temporary
 * clip, wait for its component chain to stabilize, locate Source Text,
 * explore its keyframe API (never createKeyframe or anything else that
 * could mutate the sequence), clean up the temporary clip (always,
 * whether any step above threw, failed, timed out, or was cancelled), and
 * return a JSON-safe report.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {number} [opts.scanBudgetMs]
 */
export async function testExploreKeyframeObject(opts) {
  const { mogrtPath, log, scanBudgetMs = DEFAULT_ROUND_TRIP_BUDGET_MS } = opts;

  log("════ Explore Keyframe Object — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const cancelToken = { cancelled: false };
  activeExploreKeyframeCancelToken = cancelToken;

  try {
    let project, sequence;
    try {
      ({ project, sequence } = await requireActiveProjectAndSequence());
    } catch (err) {
      log(`✗ No active project/sequence: ${err.message || err}`, "error");
      return { ok: false, step: "sequence" };
    }

    const tracksResult = await safeAsync(() => listVideoTracks(sequence));
    if (!tracksResult.ok || tracksResult.value.length === 0) {
      log(
        tracksResult.ok
          ? "✗ No video track available to insert a temporary inspection clip onto."
          : `✗ listVideoTracks() threw: ${tracksResult.error.message || tracksResult.error}`,
        "error"
      );
      return { ok: false, step: "track" };
    }
    const videoTrackIndex = tracksResult.value[tracksResult.value.length - 1].index;

    const startSec = await resolveInsertionTimeSec(sequence, log);

    log(`[stage] inserting clip from: ${mogrtPath}`, "info");
    const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log));
    if (!insertResult.ok) {
      log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
      return { ok: false, step: "insert" };
    }
    const trackItem = insertResult.value;
    log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

    const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
      async () => {
        log("[stage] waiting for MOGRT components to finish initializing…", "info");
        const stabilization = await stabilizeComponentChain(trackItem, log, { cancelToken });
        const textInfo = stabilization.discovery.components.find((c) => c.classification === "text-editing");

        if (!textInfo) {
          log(`${MOGRT_INIT_TIMEOUT_MESSAGE} No AE.ADBE Text component found — cannot explore Source Text this run.`, "warn");
          return { found: false, reason: "no-text-component", componentDiscoveryTimeline: stabilization.timeline };
        }

        log(`[stage] AE.ADBE Text found at index ${textInfo.componentIndex} — locating Source Text by displayName…`, "info");
        const located = await locateSourceTextParam(textInfo.component, textInfo.componentIndex, log);
        if (!located) {
          log('✗ No param with displayName exactly "Source Text" was found on the AE.ADBE Text component.', "error");
          return {
            found: false,
            reason: "no-source-text-param",
            componentDiscoveryTimeline: stabilization.timeline,
            componentIndex: textInfo.componentIndex,
          };
        }

        const isTimeVaryingResult =
          typeof located.param.isTimeVarying === "function"
            ? await safeResolve(() => located.param.isTimeVarying(), { log, label: "sourceText.isTimeVarying()" })
            : { ok: false };
        const areKeyframesSupportedResult =
          typeof located.param.areKeyframesSupported === "function"
            ? await safeResolve(() => located.param.areKeyframesSupported(), { log, label: "sourceText.areKeyframesSupported()" })
            : { ok: false };

        const probeBudget = createScanBudget({ totalMs: scanBudgetMs, cancelToken });
        const keyframeExploration = await exploreKeyframeObject(located.param, getPpro(), trackItem, log, probeBudget);

        return {
          found: true,
          componentIndex: textInfo.componentIndex,
          paramIndex: located.paramIndex,
          displayName: located.displayName,
          isTimeVarying: isTimeVaryingResult.ok ? isTimeVaryingResult.value : null,
          areKeyframesSupported: areKeyframesSupportedResult.ok ? areKeyframesSupportedResult.value : null,
          keyframeExploration,
          componentDiscoveryTimeline: stabilization.timeline,
        };
      },
      () => {
        log("[stage] cleaning up (removing temporary inspection clip)…", "info");
        return safeAsync(() => removeTrackItem(project, sequence, trackItem));
      },
      log
    );

    const cleanupOk = cleanupResult.ok && cleanupResult.value === true;
    if (cleanupResult.ok && cleanupResult.value) {
      log("Removed temporary inspection clip.", "info");
    } else {
      log(
        `Couldn't remove the temporary inspection clip (${
          cleanupResult.ok ? "transaction reported failure" : cleanupResult.error.message || cleanupResult.error
        }) — you may need to delete it from the timeline by hand.`,
        "warn"
      );
    }

    if (scanError) {
      log("════ Explore Keyframe Object — finished with errors (cleanup still ran) ════", "error");
      return { ok: false, step: "scan", error: String(scanError.message || scanError), cleanupOk, componentDiscoveryTimeline: [] };
    }

    const report = scanReport ?? { found: false, reason: "crash", componentDiscoveryTimeline: [] };

    if (!report.found) {
      log("════ Explore Keyframe Object — finished (Source Text not found this run) ════", "warn");
      return { ok: true, found: false, reason: report.reason, componentDiscoveryTimeline: report.componentDiscoveryTimeline, cleanupOk };
    }

    const success = Boolean(report.keyframeExploration?.resolvedValue !== null && report.keyframeExploration?.resolvedValue !== undefined);
    log(
      success
        ? `════ Explore Keyframe Object — finished: SUCCESS via ${report.keyframeExploration.workingMethod} ════`
        : "════ Explore Keyframe Object — finished (no exploration path returned a value — see keyframeExploration for details) ════",
      success ? "success" : "warn"
    );

    return { ok: true, found: true, ...report, cleanupOk };
  } finally {
    if (activeExploreKeyframeCancelToken === cancelToken) activeExploreKeyframeCancelToken = null;
  }
}

// Separate cancel-token slot from the other three entry points', for the
// same reason they're separate from each other.
let activeWriteOnlyProbeCancelToken = null;

export function cancelActiveWriteOnlyProbe() {
  if (activeWriteOnlyProbeCancelToken) {
    activeWriteOnlyProbeCancelToken.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Dedicated entry point for `runWriteOnlyProbe()`: insert a temporary
 * clip, wait for its component chain to stabilize, locate Source Text
 * (no read attempted), run the write-only probe, clean up the temporary
 * clip (ALWAYS — whether any step above threw, failed, timed out, or was
 * cancelled; this is the one diagnostic in this module that actually
 * mutates the sequence, so guaranteed cleanup matters even more here),
 * and return a JSON-safe report.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {string} [opts.sentinel]
 * @param {number} [opts.scanBudgetMs]
 */
export async function testWriteOnlyProbe(opts) {
  const { mogrtPath, log, sentinel = WRITE_PROBE_SENTINEL, scanBudgetMs = DEFAULT_ROUND_TRIP_BUDGET_MS } = opts;

  log("════ Write-Only Probe — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const cancelToken = { cancelled: false };
  activeWriteOnlyProbeCancelToken = cancelToken;

  try {
    let project, sequence;
    try {
      ({ project, sequence } = await requireActiveProjectAndSequence());
    } catch (err) {
      log(`✗ No active project/sequence: ${err.message || err}`, "error");
      return { ok: false, step: "sequence" };
    }

    const tracksResult = await safeAsync(() => listVideoTracks(sequence));
    if (!tracksResult.ok || tracksResult.value.length === 0) {
      log(
        tracksResult.ok
          ? "✗ No video track available to insert a temporary inspection clip onto."
          : `✗ listVideoTracks() threw: ${tracksResult.error.message || tracksResult.error}`,
        "error"
      );
      return { ok: false, step: "track" };
    }
    const videoTrackIndex = tracksResult.value[tracksResult.value.length - 1].index;

    const startSec = await resolveInsertionTimeSec(sequence, log);

    log(`[stage] inserting clip from: ${mogrtPath}`, "info");
    const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log));
    if (!insertResult.ok) {
      log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
      return { ok: false, step: "insert" };
    }
    const trackItem = insertResult.value;
    log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

    const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
      async () => {
        log("[stage] waiting for MOGRT components to finish initializing…", "info");
        const stabilization = await stabilizeComponentChain(trackItem, log, { cancelToken });
        const textInfo = stabilization.discovery.components.find((c) => c.classification === "text-editing");

        if (!textInfo) {
          log(`${MOGRT_INIT_TIMEOUT_MESSAGE} No AE.ADBE Text component found — cannot write-probe Source Text this run.`, "warn");
          return { found: false, reason: "no-text-component", componentDiscoveryTimeline: stabilization.timeline };
        }

        log(`[stage] AE.ADBE Text found at index ${textInfo.componentIndex} — locating Source Text by displayName (not reading it)…`, "info");
        const located = await locateSourceTextParam(textInfo.component, textInfo.componentIndex, log);
        if (!located) {
          log('✗ No param with displayName exactly "Source Text" was found on the AE.ADBE Text component.', "error");
          return {
            found: false,
            reason: "no-source-text-param",
            componentDiscoveryTimeline: stabilization.timeline,
            componentIndex: textInfo.componentIndex,
          };
        }

        const probeBudget = createScanBudget({ totalMs: scanBudgetMs, cancelToken });
        const writeProbe = await runWriteOnlyProbe({
          project,
          trackItem,
          componentIndex: textInfo.componentIndex,
          paramIndex: located.paramIndex,
          param: located.param,
          displayName: located.displayName,
          sentinel,
          log,
          budget: probeBudget,
          ppro: getPpro(),
        });

        return { found: true, writeProbe, componentDiscoveryTimeline: stabilization.timeline };
      },
      () => {
        log("[stage] cleaning up (removing temporary inspection clip)…", "info");
        return safeAsync(() => removeTrackItem(project, sequence, trackItem));
      },
      log
    );

    const cleanupOk = cleanupResult.ok && cleanupResult.value === true;
    if (cleanupResult.ok && cleanupResult.value) {
      log("Removed temporary inspection clip.", "info");
    } else {
      log(
        `Couldn't remove the temporary inspection clip (${
          cleanupResult.ok ? "transaction reported failure" : cleanupResult.error.message || cleanupResult.error
        }) — you may need to delete it from the timeline by hand.`,
        "warn"
      );
    }

    if (scanError) {
      log("════ Write-Only Probe — finished with errors (cleanup still ran) ════", "error");
      return { ok: false, step: "scan", error: String(scanError.message || scanError), cleanupOk, componentDiscoveryTimeline: [] };
    }

    const report = scanReport ?? { found: false, reason: "crash", componentDiscoveryTimeline: [] };

    if (!report.found) {
      log("════ Write-Only Probe — finished (Source Text not found this run) ════", "warn");
      return { ok: true, found: false, reason: report.reason, componentDiscoveryTimeline: report.componentDiscoveryTimeline, cleanupOk };
    }

    const outcome = report.writeProbe?.outcome;
    const summaryText = {
      "write-succeeded-and-confirmed": "════ Write-Only Probe — finished: SUCCESS (write reported success AND the automated read-back confirms it) ════",
      "write-api-succeeded-visible-change-unconfirmed":
        "════ Write-Only Probe — finished: API reported success, but the visible/automated change could NOT be confirmed — reported separately, see writeProbe ════",
      "write-action-failed": "════ Write-Only Probe — finished: createSetValueAction failed — see writeProbe ════",
      "transaction-failed": "════ Write-Only Probe — finished: executeTransaction failed — see writeProbe ════",
      "write-succeeded-reacquire-failed": "════ Write-Only Probe — finished: write succeeded but re-acquiring the param afterward failed — see writeProbe ════",
    }[outcome] ?? "════ Write-Only Probe — finished (unexpected state — see writeProbe) ════";
    log(summaryText, outcome === "write-succeeded-and-confirmed" ? "success" : "warn");

    return { ok: true, found: true, writeProbe: report.writeProbe, componentDiscoveryTimeline: report.componentDiscoveryTimeline, cleanupOk };
  } finally {
    if (activeWriteOnlyProbeCancelToken === cancelToken) activeWriteOnlyProbeCancelToken = null;
  }
}

// Separate cancel-token slot from the other four entry points', for the
// same reason they're separate from each other.
let activeValueShapesCancelToken = null;

export function cancelActiveValueShapesProbe() {
  if (activeValueShapesCancelToken) {
    activeValueShapesCancelToken.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Dedicated entry point for `probeSourceTextValueShapes()`: insert a
 * temporary clip, wait for its component chain to stabilize, locate
 * Source Text, run the value-shapes probe, clean up the temporary clip
 * (ALWAYS — this probe can execute a real transaction for whichever
 * candidate succeeds), and return a JSON-safe report.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {string} [opts.sentinel]
 * @param {number} [opts.scanBudgetMs]
 */
export async function testProbeSourceTextValueShapes(opts) {
  const { mogrtPath, log, sentinel = WRITE_PROBE_SENTINEL, scanBudgetMs = DEFAULT_ROUND_TRIP_BUDGET_MS } = opts;

  log("════ Probe Source Text Value Shapes — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const cancelToken = { cancelled: false };
  activeValueShapesCancelToken = cancelToken;

  try {
    let project, sequence;
    try {
      ({ project, sequence } = await requireActiveProjectAndSequence());
    } catch (err) {
      log(`✗ No active project/sequence: ${err.message || err}`, "error");
      return { ok: false, step: "sequence" };
    }

    const tracksResult = await safeAsync(() => listVideoTracks(sequence));
    if (!tracksResult.ok || tracksResult.value.length === 0) {
      log(
        tracksResult.ok
          ? "✗ No video track available to insert a temporary inspection clip onto."
          : `✗ listVideoTracks() threw: ${tracksResult.error.message || tracksResult.error}`,
        "error"
      );
      return { ok: false, step: "track" };
    }
    const videoTrackIndex = tracksResult.value[tracksResult.value.length - 1].index;

    const startSec = await resolveInsertionTimeSec(sequence, log);

    log(`[stage] inserting clip from: ${mogrtPath}`, "info");
    const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log));
    if (!insertResult.ok) {
      log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
      return { ok: false, step: "insert" };
    }
    const trackItem = insertResult.value;
    log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

    const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
      async () => {
        log("[stage] waiting for MOGRT components to finish initializing…", "info");
        const stabilization = await stabilizeComponentChain(trackItem, log, { cancelToken });
        const textInfo = stabilization.discovery.components.find((c) => c.classification === "text-editing");

        if (!textInfo) {
          log(`${MOGRT_INIT_TIMEOUT_MESSAGE} No AE.ADBE Text component found — cannot probe Source Text this run.`, "warn");
          return { found: false, reason: "no-text-component", componentDiscoveryTimeline: stabilization.timeline };
        }

        log(`[stage] AE.ADBE Text found at index ${textInfo.componentIndex} — locating Source Text by displayName…`, "info");
        const located = await locateSourceTextParam(textInfo.component, textInfo.componentIndex, log);
        if (!located) {
          log('✗ No param with displayName exactly "Source Text" was found on the AE.ADBE Text component.', "error");
          return {
            found: false,
            reason: "no-source-text-param",
            componentDiscoveryTimeline: stabilization.timeline,
            componentIndex: textInfo.componentIndex,
          };
        }

        const probeBudget = createScanBudget({ totalMs: scanBudgetMs, cancelToken });
        const valueShapesProbe = await probeSourceTextValueShapes({
          project,
          trackItem,
          param: located.param,
          displayName: located.displayName,
          sentinel,
          log,
          budget: probeBudget,
          ppro: getPpro(),
        });

        return {
          found: true,
          componentIndex: textInfo.componentIndex,
          paramIndex: located.paramIndex,
          displayName: located.displayName,
          valueShapesProbe,
          componentDiscoveryTimeline: stabilization.timeline,
        };
      },
      () => {
        log("[stage] cleaning up (removing temporary inspection clip)…", "info");
        return safeAsync(() => removeTrackItem(project, sequence, trackItem));
      },
      log
    );

    const cleanupOk = cleanupResult.ok && cleanupResult.value === true;
    if (cleanupResult.ok && cleanupResult.value) {
      log("Removed temporary inspection clip.", "info");
    } else {
      log(
        `Couldn't remove the temporary inspection clip (${
          cleanupResult.ok ? "transaction reported failure" : cleanupResult.error.message || cleanupResult.error
        }) — you may need to delete it from the timeline by hand.`,
        "warn"
      );
    }

    if (scanError) {
      log("════ Probe Source Text Value Shapes — finished with errors (cleanup still ran) ════", "error");
      return { ok: false, step: "scan", error: String(scanError.message || scanError), cleanupOk, componentDiscoveryTimeline: [] };
    }

    const report = scanReport ?? { found: false, reason: "crash", componentDiscoveryTimeline: [] };

    if (!report.found) {
      log("════ Probe Source Text Value Shapes — finished (Source Text not found this run) ════", "warn");
      return { ok: true, found: false, reason: report.reason, componentDiscoveryTimeline: report.componentDiscoveryTimeline, cleanupOk };
    }

    const success = Boolean(report.valueShapesProbe?.verifiedWrite?.automatedCheckConfirmsChange);
    log(
      success
        ? `════ Probe Source Text Value Shapes — finished: SUCCESS via "${report.valueShapesProbe.workingCandidateName}" ════`
        : "════ Probe Source Text Value Shapes — finished (no documented value shape was confirmed — see valueShapesProbe) ════",
      success ? "success" : "warn"
    );

    return { ok: true, found: true, valueShapesProbe: report.valueShapesProbe, componentDiscoveryTimeline: report.componentDiscoveryTimeline, cleanupOk };
  } finally {
    if (activeValueShapesCancelToken === cancelToken) activeValueShapesCancelToken = null;
  }
}
