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
import { requireActiveProjectAndSequence, getSelectedRangeSeconds, listVideoTracks } from "./timelineRange.js";
import { insertMogrtAt, removeTrackItem } from "./mogrt.js";
import { safe, safeAsync, safeResolve } from "./introspect.js";
import { summarizeHostValue, unwrapValueDeep, createScanBudget, PROBE_CALL_TIMEOUT_MS } from "./deepProbe.js";
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
export function runTransaction(project, action, paramLabel, log) {
  let success = false;
  let error = null;
  try {
    project.lockedAccess(() => {
      success = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(action);
      }, `Diagnostic Source Text round trip (${paramLabel ?? "Source Text"})`);
    });
  } catch (err) {
    error = String(err.message || err);
    log(`✗ executeTransaction threw: ${error}`, "error");
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

  log("[stage] reading Source Text with valid TickTime arguments…", "info");
  const readAttempts = await readSourceTextAttempts(trackItem, param, ppro, log, budget);

  log("[stage] testing non-mutating keyframe construction (createKeyframe, no sequence change)…", "info");
  const keyframeCreation = await testKeyframeCreation(param, sentinel, log, budget);

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
  } else {
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
    readAttempts,
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

    const rangeResult = await safeAsync(() => getSelectedRangeSeconds(sequence));
    const startSec = rangeResult.ok ? rangeResult.value.startSec : 0;

    log(`[stage] inserting clip from: ${mogrtPath}`, "info");
    const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex));
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
