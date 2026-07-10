/**
 * Diagnostic Inspector: a much more verbose, non-judgmental dump of a track
 * item's full component/param graph, built to answer one open question
 * before this extension builds any automatic param-name mapping: does
 * `trackItem.getComponentChain()` (the only enumeration API this project has
 * found in Adobe's public UXP sample/reference material — see
 * docs/MOGRT_DIAGNOSTIC.md) surface a Premiere-native MOGRT's own editable
 * graphic/text controls at all, or only the intrinsic Motion/Opacity/Crop/
 * Time Remapping components every track item has regardless of its content?
 *
 * Unlike templateInspector.js (which asks "does this satisfy contract X?"),
 * this module makes NO assumption about which discovered params are
 * meaningful. It classifies each component by a conservative, clearly-a-
 * heuristic name match and reports every param's display name, best-effort
 * match name, value type, and current value, so a human can read the real
 * host output and decide — see docs/MOGRT_DIAGNOSTIC.md for how to read it.
 */
import { requireActiveProjectAndSequence, getSelectedRangeSeconds, listVideoTracks } from "./timelineRange.js";
import { insertMogrtAt, removeTrackItem } from "./mogrt.js";
import { safe, safeAsync, safeResolve, resolveHostValue, toSafeString } from "./introspect.js";
import { summarizeHostValue, formatSummaryForLog, probeHostObject, createScanBudget, DEFAULT_SCAN_BUDGET_MS } from "./deepProbe.js";

const MAX_COMPONENT_SCAN = 64;
const MAX_PARAM_SCAN = 64;
// How many consecutive empty/failed component indices to tolerate before
// giving up the scan. >1 so a single transient null doesn't hide a gap in
// the chain (unconfirmed whether the real host ever has such gaps — this is
// diagnostic-mode-only tolerance, not used by the stricter templateInspector
// scan, which intentionally stops at the first miss).
const CONSECUTIVE_MISS_TOLERANCE = 3;

// Component display names Premiere puts on every (or nearly every) video
// track item regardless of its content — confirmed by observation (see
// docs/MOGRT_DIAGNOSTIC.md's real host output), not by an Adobe reference
// list (no such enumeration was found in the public docs). Matched
// case-insensitively, exact name only — deliberately narrow, so an unknown
// component name is never misclassified as intrinsic just because it sounds
// similar.
const INTRINSIC_COMPONENT_NAMES = new Set([
  "motion",
  "opacity",
  "time remapping",
  "crop",
  "channel volume",
  "volume",
]);

// AE.ADBE-prefixed matchNames (and, on some hosts, displayNames — see
// below) for the SAME standard/intrinsic components as
// INTRINSIC_COMPONENT_NAMES above. Confirmed by a real Diagnostic Inspector
// run against a Premiere-native (no After Effects) MOGRT on Premiere Pro
// 26.3, which reported exactly these three components:
// "AE.ADBE Opacity", "AE.ADBE Motion", "AE.ADBE Graphic Group". Premiere
// Graphics clips are apparently represented internally via AE-style
// matchNames even when authored without After Effects — so a bare
// "ae.adbe" substring is NOT a reliable "this is custom MOGRT content"
// signal (an earlier version of this classifier used it as one, which
// misclassified all three of the above as "graphic-or-mogrt" — i.e.
// reported the scan as having found real controls when it hadn't).
// "AE.ADBE Graphic Group" specifically is the wrapper/container for
// whatever custom content the graphic has — intrinsic to every graphic
// clip the same way Motion/Opacity are intrinsic to every clip, not itself
// a discovered custom control. If the graphic exposes real editable
// controls, they must be reachable *inside* this group or via a different
// route entirely — see the raw probe in diagnoseMogrt()/docs/MOGRT_DIAGNOSTIC.md.
const INTRINSIC_MATCH_NAMES = new Set([
  "ae.adbe opacity",
  "ae.adbe motion",
  "ae.adbe transform",
  "ae.adbe time remapping",
  "ae.adbe crop",
  "ae.adbe channel volume",
  "ae.adbe graphic group",
]);

// Narrow, specific signals that a component is genuinely the MOGRT's own
// editable content — deliberately NOT including a bare "ae.adbe" (see
// INTRINSIC_MATCH_NAMES comment above for why that was wrong). "text" is
// kept because Adobe forum threads specifically describe locating an
// After-Effects-authored MOGRT's Source Text control via a matchName
// containing "AE.ADBE Text" (see docs/MOGRT_DIAGNOSTIC.md's research
// notes) — not confirmed against this project's own host output yet, since
// no such component has been observed so far, but specific enough to be
// worth flagging rather than silently grouping with "effect-or-unknown".
const GRAPHIC_NAME_SIGNALS = ["mogrt", "essential graphics", "video/graphic", "text", "graphic"];

// Safe string-or-empty lowercasing: NEVER calls a string method on
// anything that isn't already a plain string, so a caller passing through
// an unresolved Promise (or any other unexpected host value) can't crash
// classification — confirmed root cause of "(matchName || "").trim is not a
// function" on Premiere Pro 26.3, where `TrackItem.matchName` returned a
// live Promise instead of a string. Callers are still expected to resolve
// Promise-like host values via resolveHostValue()/toSafeString() BEFORE
// calling classifyComponent()/textLikeSignal() — this is a second,
// belt-and-suspenders guard, not a substitute for doing that.
function safeLower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * @param {{ displayName?: string|null, matchName?: string|null }} info
 * @returns {{ classification: "intrinsic"|"graphic-or-mogrt"|"effect-or-unknown", reason: string }}
 */
export function classifyComponent({ displayName, matchName }) {
  const name = safeLower(displayName);
  const match = safeLower(matchName);

  if (INTRINSIC_COMPONENT_NAMES.has(name) || INTRINSIC_COMPONENT_NAMES.has(match)) {
    return { classification: "intrinsic", reason: `display name/matchName exactly matches a known intrinsic component name` };
  }
  if (INTRINSIC_MATCH_NAMES.has(match) || INTRINSIC_MATCH_NAMES.has(name)) {
    return { classification: "intrinsic", reason: `display name/matchName "${matchName || displayName}" is a known AE.ADBE-prefixed intrinsic component` };
  }

  const signalHit = GRAPHIC_NAME_SIGNALS.find((sig) => name.includes(sig) || match.includes(sig));
  if (signalHit) {
    return { classification: "graphic-or-mogrt", reason: `name/matchName contains "${signalHit}"` };
  }

  return {
    classification: "effect-or-unknown",
    reason: "not a recognized intrinsic name and no graphic/MOGRT signal in name or matchName — could be a user-applied effect, or an unrecognized graphic/MOGRT wrapper; needs human judgment",
  };
}

/**
 * Best-effort matchName reader: tries every plausible accessor shape
 * (property, then a getMatchName() method) and reports which one worked —
 * treating BOTH as possibly async, since Premiere Pro 26.3 returned a live
 * Promise from a plain `matchName` property read, not just from an
 * explicit method call (see resolveHostValue() in ./introspect.js). Every
 * value returned here is guaranteed to already be a plain string or null —
 * never a raw Promise/object — so callers never need to re-check.
 *
 * @param {*} obj
 * @param {(message: string, level?: string) => void} [log]
 */
export async function readMatchName(obj, log) {
  const attempts = [
    { source: "matchName (property)", fn: () => obj.matchName },
    { source: "getMatchName() (method)", fn: () => (typeof obj.getMatchName === "function" ? obj.getMatchName() : undefined) },
  ];
  for (const attempt of attempts) {
    const raw = safe(attempt.fn);
    if (!raw.ok || raw.value === undefined || raw.value === null) continue;
    const resolved = await resolveHostValue(raw.value, null, { log, label: `matchName via ${attempt.source}` });
    const asString = toSafeString(resolved);
    if (asString !== null) return { value: asString, source: attempt.source };
  }
  return { value: null, source: null };
}

/**
 * Best-effort displayName reader, same async-safe treatment as
 * readMatchName() above — `displayName` is host-returned metadata too, so
 * it gets the same "might be a Promise" treatment rather than being
 * special-cased as always-synchronous.
 *
 * @param {*} obj
 * @param {(message: string, level?: string) => void} [log]
 */
export async function readDisplayName(obj, log) {
  const raw = safe(() => obj.displayName);
  if (!raw.ok || raw.value === undefined || raw.value === null) return null;
  const resolved = await resolveHostValue(raw.value, null, { log, label: "displayName" });
  return toSafeString(resolved);
}

export function textLikeSignal(displayName, matchName) {
  const name = `${safeLower(displayName)} ${safeLower(matchName)}`;
  return name.includes("text") || name.includes("source text");
}

/** Best-effort param type reader: tries `.type`, then `.paramType`, either of which might throw, reject, or resolve async. */
async function readParamType(param, ci, pi, log) {
  const attempts = [
    () => param.type,
    () => param.paramType,
  ];
  for (const fn of attempts) {
    const result = await safeResolve(fn, { log, label: `component[${ci}].param[${pi}].type` });
    if (result.ok && result.value !== undefined && result.value !== null) return result.value;
  }
  return "unknown";
}

/**
 * Walk every component/param on a track item with full detail, logging
 * progressively and returning a JSON-serializable report. See module
 * doc-comment for what this is trying to settle. Stops early (marking
 * `partial: true`) the moment `budget` (if given) expires — see
 * src/ppro/deepProbe.js's createScanBudget().
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function deepDumpComponentChain(trackItem, log, budget) {
  log("[stage] reading track item — component chain (no name assumptions)…", "info");

  const typeNameResult = await safeResolve(() => trackItem.constructor?.name, { log, label: "trackItem type" });
  const trackItemMatchName = await readMatchName(trackItem, log);
  const trackItemInfo = {
    typeName: (typeNameResult.ok && typeNameResult.value) || "unknown",
    matchName: trackItemMatchName.value,
  };
  log(`TrackItem: type=${trackItemInfo.typeName}, matchName=${trackItemInfo.matchName ?? "n/a"}`, "info");

  const chainResult = await safeResolve(() => trackItem.getComponentChain(), { log, label: "getComponentChain()" });
  if (!chainResult.ok) {
    log(`✗ getComponentChain() failed: ${chainResult.error.message || chainResult.error}`, "error");
    return { trackItem: trackItemInfo, components: [], scanStoppedEarly: true };
  }
  const chain = chainResult.value;
  if (!chain) {
    log("✗ getComponentChain() returned nothing.", "error");
    return { trackItem: trackItemInfo, components: [], scanStoppedEarly: true };
  }

  const components = [];
  let consecutiveMisses = 0;
  let partial = false;

  for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
    if (budget && budget.isExpired()) {
      log(`Component scan stopped early at index ${ci}: ${budget.reason()}.`, "warn");
      partial = true;
      break;
    }
    const componentResult = await safeResolve(() => chain.getComponentAtIndex(ci), { log, label: `component[${ci}]` });
    if (!componentResult.ok || !componentResult.value) {
      consecutiveMisses += 1;
      log(
        `Component index ${ci}: ${componentResult.ok ? "no component returned" : `failed (${componentResult.error.message || componentResult.error})`} ` +
          `(${consecutiveMisses}/${CONSECUTIVE_MISS_TOLERANCE} consecutive misses before stopping)`,
        "info"
      );
      if (consecutiveMisses >= CONSECUTIVE_MISS_TOLERANCE) break;
      continue;
    }
    consecutiveMisses = 0;
    const component = componentResult.value;

    const displayName = await readDisplayName(component, log);
    const matchNameResult = await readMatchName(component, log);
    const { classification, reason } = classifyComponent({ displayName, matchName: matchNameResult.value });

    log(
      `Component ${ci}: displayName="${displayName ?? "n/a"}", matchName=${matchNameResult.value ?? "n/a"}` +
        `${matchNameResult.source ? ` (via ${matchNameResult.source})` : ""} → classified as ${classification.toUpperCase()} (${reason})`,
      classification === "graphic-or-mogrt" ? "success" : "info"
    );

    const params = [];
    let paramMisses = 0;
    for (let pi = 0; pi < MAX_PARAM_SCAN; pi++) {
      if (budget && budget.isExpired()) {
        log(`Param scan on component ${ci} stopped early at index ${pi}: ${budget.reason()}.`, "warn");
        partial = true;
        break;
      }
      const paramResult = await safeResolve(() => component.getParam(pi), { log, label: `component[${ci}].param[${pi}]` });
      if (!paramResult.ok || !paramResult.value) {
        paramMisses += 1;
        if (paramMisses >= 1) break; // params are dense within a component; one miss ends it (unlike the component-level scan)
        continue;
      }
      const param = paramResult.value;

      const paramDisplayName = await readDisplayName(param, log);
      const paramMatchNameResult = await readMatchName(param, log);
      const paramType = await readParamType(param, ci, pi, log);
      const startValue = await safeAsync(() => param.getStartValue());
      const resolvedValue = startValue.ok
        ? await resolveHostValue(startValue.value, undefined, { log, label: `component[${ci}].param[${pi}].value` })
        : undefined;
      // summarizeHostValue() (not JSON.stringify) is what fixes "value: {}":
      // UXP native-bridge objects apparently expose their real data through
      // non-enumerable getters, which JSON.stringify silently sees nothing
      // in — see docs/MOGRT_DIAGNOSTIC.md and src/ppro/deepProbe.js.
      const valueSummary = startValue.ok ? summarizeHostValue(resolvedValue) : { kind: "unreadable", error: String(startValue.error.message || startValue.error) };
      const isTextLike = textLikeSignal(paramDisplayName, paramMatchNameResult.value);

      log(
        `  Param ${pi}: displayName="${paramDisplayName ?? "n/a"}", matchName=${paramMatchNameResult.value ?? "n/a"}` +
          `${paramMatchNameResult.source ? ` (via ${paramMatchNameResult.source})` : ""}, type=${paramType}, ` +
          `value=${formatSummaryForLog(valueSummary)}${isTextLike ? " — TEXT-LIKE NAME" : ""}`,
        "info"
      );

      params.push({
        paramIndex: pi,
        displayName: paramDisplayName,
        matchName: paramMatchNameResult.value,
        matchNameSource: paramMatchNameResult.source,
        type: paramType,
        value: valueSummary,
        textLikeSignal: isTextLike,
      });
    }

    components.push({
      componentIndex: ci,
      displayName,
      matchName: matchNameResult.value,
      matchNameSource: matchNameResult.source,
      classification,
      classificationReason: reason,
      paramCount: params.length,
      params,
    });
  }

  const byClass = components.reduce((acc, c) => {
    acc[c.classification] = (acc[c.classification] || 0) + 1;
    return acc;
  }, {});
  log(
    `Diagnostic scan complete: ${components.length} component(s) — ` +
      `${byClass.intrinsic ?? 0} intrinsic, ${byClass["graphic-or-mogrt"] ?? 0} graphic-or-mogrt, ${byClass["effect-or-unknown"] ?? 0} effect-or-unknown.` +
      (partial ? " (STOPPED EARLY — time budget or cancellation, see above)" : ""),
    partial ? "warn" : "success"
  );

  return { trackItem: trackItemInfo, components, scanStoppedEarly: false, classificationPartial: partial };
}

/**
 * Best-effort "does this track item have an associated project item"
 * reader — tries a property first, then a getter method, same async-safe
 * pattern as readMatchName()/readDisplayName(). Neither accessor name is
 * confirmed against official Adobe docs (both blocked from this
 * environment — see docs/MOGRT_DIAGNOSTIC.md); this tries the two most
 * plausible shapes rather than assuming either.
 *
 * @param {*} trackItem
 * @param {(message: string, level?: string) => void} [log]
 */
async function resolveProjectItem(trackItem, log) {
  const attempts = [
    { source: "projectItem (property)", fn: () => trackItem.projectItem },
    { source: "getProjectItem() (method)", fn: () => (typeof trackItem.getProjectItem === "function" ? trackItem.getProjectItem() : undefined) },
  ];
  for (const attempt of attempts) {
    const result = await safeResolve(attempt.fn, { log, label: `trackItem.${attempt.source}` });
    if (result.ok && result.value !== undefined && result.value !== null) {
      return { value: result.value, source: attempt.source };
    }
  }
  return { value: null, source: null };
}

/**
 * The deeper raw probe: inspects the real shape (Object.keys,
 * Object.getOwnPropertyNames, prototype method/property names, constructor,
 * safely-called zero-arg getters) of the track item, its associated project
 * item (if any accessor for one is found), every component, every param,
 * and the resolved objects from both `param.getStartValue()` and
 * `param.getValue()` (feature-detected — `getValue` is not used anywhere
 * else in this codebase and its existence is unconfirmed, per the task that
 * asked for this probe). This is deliberately separate from
 * deepDumpComponentChain()'s classification-focused walk: it re-walks the
 * same chain, but everything it records is unconditional — classification
 * never gates what gets probed, since the whole point is finding controls
 * the classifier doesn't recognize.
 *
 * Returns a plain, JSON-safe object (see src/ppro/deepProbe.js — every
 * probe result is a summary, never a raw host reference), meant to be
 * saved to its own file rather than folded into the same JSON as the
 * classification report (which stays comparatively compact for quick
 * reading).
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @param {Object} [opts]
 * @param {ReturnType<typeof createScanBudget>} [opts.budget]
 * @param {number} [opts.expectedComponentCount] From the classification scan, for "component i/N" progress logs — purely cosmetic, never gates behavior.
 * @param {number[]} [opts.expectedParamCounts] Same, per component, for "param j/M" progress logs.
 */
export async function deepProbeMogrt(trackItem, log, opts = {}) {
  const { budget, expectedComponentCount, expectedParamCounts } = opts;

  log("[stage] probing deeper (raw host-object probe): trackItem, projectItem, every component/param, resolved values…", "info");

  if (budget && budget.isExpired()) {
    log(`Raw probe skipped entirely: ${budget.reason()} before it could start.`, "warn");
    return { trackItemProbe: { label: "trackItem", skipped: true, reason: budget.reason() }, projectItemProbe: { label: "trackItem.projectItem", skipped: true, reason: budget.reason() }, components: [], partial: true };
  }

  const trackItemProbe = await probeHostObject(trackItem, "trackItem", log, budget);

  log("[stage] probing project item…", "info");
  const projectItemResult = budget && budget.isExpired() ? { value: null, source: null } : await resolveProjectItem(trackItem, log);
  const projectItemProbe = projectItemResult.value
    ? { ...(await probeHostObject(projectItemResult.value, "trackItem.projectItem", log, budget)), accessorSource: projectItemResult.source }
    : { label: "trackItem.projectItem", exists: false, accessorSource: null };
  log(
    projectItemResult.value
      ? `Raw probe: found an associated project item via ${projectItemResult.source}.`
      : "Raw probe: no associated project item found via either tried accessor (or the scan budget ran out first).",
    projectItemResult.value ? "success" : "warn"
  );

  const chainResult = await safeResolve(() => trackItem.getComponentChain(), { log, label: "getComponentChain() (raw probe)" });
  const components = [];
  let partial = false;
  if (chainResult.ok && chainResult.value) {
    const chain = chainResult.value;
    let consecutiveMisses = 0;
    for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
      if (budget && budget.isExpired()) {
        log(`Raw probe stopped early before component ${ci}: ${budget.reason()}.`, "warn");
        partial = true;
        break;
      }
      const componentResult = await safeResolve(() => chain.getComponentAtIndex(ci), { log, label: `component[${ci}] (raw probe)` });
      if (!componentResult.ok || !componentResult.value) {
        consecutiveMisses += 1;
        if (consecutiveMisses >= CONSECUTIVE_MISS_TOLERANCE) break;
        continue;
      }
      consecutiveMisses = 0;
      const component = componentResult.value;
      log(`[stage] probing component ${ci + 1}${expectedComponentCount ? `/${expectedComponentCount}` : ""}…`, "info");
      const componentProbe = await probeHostObject(component, `component[${ci}]`, log, budget);

      const params = [];
      let paramMisses = 0;
      const expectedParamCount = expectedParamCounts?.[ci];
      for (let pi = 0; pi < MAX_PARAM_SCAN; pi++) {
        if (budget && budget.isExpired()) {
          log(`Raw probe stopped early before param ${pi} on component ${ci + 1}: ${budget.reason()}.`, "warn");
          partial = true;
          break;
        }
        const paramResult = await safeResolve(() => component.getParam(pi), { log, label: `component[${ci}].param[${pi}] (raw probe)` });
        if (!paramResult.ok || !paramResult.value) {
          paramMisses += 1;
          if (paramMisses >= 1) break;
          continue;
        }
        const param = paramResult.value;
        log(
          `  [stage] probing parameter ${pi + 1}${expectedParamCount ? `/${expectedParamCount}` : ""} on component ${ci + 1}${expectedComponentCount ? `/${expectedComponentCount}` : ""}…`,
          "info"
        );
        const paramProbe = await probeHostObject(param, `component[${ci}].param[${pi}]`, log, budget);

        const startValueResult = await safeResolve(() => param.getStartValue(), { log, label: `component[${ci}].param[${pi}].getStartValue()` });
        const startValueProbe = startValueResult.ok
          ? await probeHostObject(startValueResult.value, `component[${ci}].param[${pi}].getStartValue()`, log, budget)
          : { label: `component[${ci}].param[${pi}].getStartValue()`, exists: false, error: String(startValueResult.error.message || startValueResult.error) };

        // `getValue` is not used anywhere else in this codebase — its
        // existence on ComponentParam is unconfirmed. Feature-detected,
        // never assumed.
        let getValueProbe = { label: `component[${ci}].param[${pi}].getValue()`, exists: false, note: "getValue is not a function on this param" };
        if (typeof param.getValue === "function" && !(budget && budget.isExpired())) {
          const getValueResult = await safeResolve(() => param.getValue(), { log, label: `component[${ci}].param[${pi}].getValue()` });
          getValueProbe = getValueResult.ok
            ? await probeHostObject(getValueResult.value, `component[${ci}].param[${pi}].getValue()`, log, budget)
            : { label: `component[${ci}].param[${pi}].getValue()`, exists: false, error: String(getValueResult.error.message || getValueResult.error) };
        }

        params.push({ paramIndex: pi, probe: paramProbe, startValueProbe, getValueProbe });
      }

      components.push({ componentIndex: ci, probe: componentProbe, params });
      if (partial) break;
    }
  }

  log("[stage] serializing raw probe results…", "info");
  log(
    `Raw probe complete: ${components.length} component(s) probed, ${components.reduce((sum, c) => sum + c.params.length, 0)} param(s) probed in depth.` +
      (partial ? " (STOPPED EARLY — time budget or cancellation)" : ""),
    partial ? "warn" : "success"
  );

  return { trackItemProbe, projectItemProbe, components, partial };
}

/**
 * Runs `scanFn()`, then ALWAYS runs `cleanupFn()` afterward — regardless of
 * whether `scanFn` threw — so a diagnostic scan crash can never leave the
 * temporary inspection clip stranded on the timeline. Confirmed
 * reproducible failure mode this fixes: the previous version only ran
 * cleanup after a successful scan, so a thrown error partway through left
 * the inserted clip behind.
 *
 * `scanFn`'s error (if any) is captured and returned rather than
 * re-thrown, so the caller has one place to decide what to do with both
 * the scan outcome and the cleanup outcome. Extracted as its own function
 * (rather than inlined in diagnoseMogrt) so this guarantee is unit-testable
 * without a live Premiere host — see test/diagnostics.test.js.
 *
 * @param {() => Promise<*>} scanFn
 * @param {() => Promise<{ ok: boolean, value?: *, error?: Error }>} cleanupFn
 * @param {(message: string, level?: string) => void} [log]
 * @returns {Promise<{ report: *, scanError: Error|null, cleanupResult: { ok: boolean, value?: *, error?: Error } }>}
 */
export async function runScanWithGuaranteedCleanup(scanFn, cleanupFn, log) {
  let report;
  let scanError = null;
  let cleanupResult;
  try {
    report = await scanFn();
  } catch (err) {
    scanError = err;
    if (log) log(`✗ Diagnostic scan crashed: ${err.message || err}`, "error");
  } finally {
    cleanupResult = await cleanupFn();
  }
  return { report, scanError, cleanupResult };
}

// The single in-flight diagnostic run's cancel token, if any — module-level
// because the UI's Cancel button (src/ui/templateInspectorPanel.js) has no
// other way to reach a scan already in progress inside diagnoseMogrt(). Only
// one diagnostic can run at a time (the panel disables the run button while
// `diagnosing` is true), so a single slot is enough. This is a *cooperative*
// cancel: it doesn't abort any in-flight host call, it just makes the next
// budget check (between fields/methods/params/components) stop early — see
// src/ppro/deepProbe.js's createScanBudget().
let activeCancelToken = null;

/**
 * Ask the currently-running diagnostic scan (if any) to stop at its next
 * checkpoint. Returns true if there was one to cancel. A reload of the
 * panel (rather than clicking Cancel) can't be intercepted the same way —
 * the whole JS context is torn down, so nothing can run its cleanup after
 * that point; Cancel first if you can.
 */
export function cancelActiveDiagnostic() {
  if (activeCancelToken) {
    activeCancelToken.cancelled = true;
    return true;
  }
  return false;
}

/**
 * Insert a .mogrt on the active sequence, run the deep component dump on it,
 * clean up the temporary clip, and return the full structured report. Reuses
 * the exact same insert/cleanup plumbing as templateInspector.js (see
 * ./mogrt.js) so this mode's insertion behavior can't drift from the regular
 * inspector's.
 *
 * Bounded to finish within `opts.scanBudgetMs` (default
 * DEFAULT_SCAN_BUDGET_MS, ~12s) regardless of how much there is to probe or
 * whether anything in the probed object graph hangs — see
 * src/ppro/deepProbe.js's module doc-comment for the three independent
 * bounds (per-call timeout, shared scan budget, structural caps) that make
 * this guarantee hold.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {number} [opts.scanBudgetMs]
 */
export async function diagnoseMogrt(opts) {
  const { mogrtPath, log, scanBudgetMs = DEFAULT_SCAN_BUDGET_MS } = opts;

  log("════ Diagnostic Inspector — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected to diagnose.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  // One cancel token per run, published to the module-level slot so the
  // UI's Cancel button can reach it (see activeCancelToken above). Cleared
  // in `finally` no matter how this function returns, so a stale token can
  // never linger and "cancel" a future, unrelated run.
  const cancelToken = { cancelled: false };
  activeCancelToken = cancelToken;
  const budget = createScanBudget({ totalMs: scanBudgetMs, cancelToken });

  try {
    let project, sequence;
    try {
      ({ project, sequence } = await requireActiveProjectAndSequence());
    } catch (err) {
      log(`✗ No active project/sequence: ${err.message || err}`, "error");
      log("════ Diagnostic Inspector aborted ════", "error");
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
      log("════ Diagnostic Inspector aborted ════", "error");
      return { ok: false, step: "track" };
    }
    const videoTrackIndex = tracksResult.value[tracksResult.value.length - 1].index;

    const rangeResult = await safeAsync(() => getSelectedRangeSeconds(sequence));
    const startSec = rangeResult.ok ? rangeResult.value.startSec : 0;

    log(`[stage] inserting clip from: ${mogrtPath}`, "info");
    const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex));
    if (!insertResult.ok) {
      log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
      log("════ Diagnostic Inspector aborted — nothing to inspect ════", "error");
      return { ok: false, step: "insert" };
    }
    const trackItem = insertResult.value;
    log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

    // Cleanup is guaranteed even if either scan throws OR the scan budget/
    // cancellation cuts it short — see runScanWithGuaranteedCleanup()'s doc
    // comment for the crash failure mode, and deepProbe.js's module
    // doc-comment for the hang failure mode this budget fixes. Both the
    // classification scan and the deeper raw probe run against the same
    // single inserted clip and share the SAME budget, so there's only one
    // insert/cleanup cycle and one overall time bound regardless of how
    // much probing happens.
    const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
      async () => {
        const componentReport = await deepDumpComponentChain(trackItem, log, budget);
        const rawProbe = await deepProbeMogrt(trackItem, log, {
          budget,
          expectedComponentCount: componentReport.components.length,
          expectedParamCounts: componentReport.components.map((c) => c.paramCount),
        });
        log("[stage] serializing results…", "info");
        return { ...componentReport, rawProbe, partial: Boolean(componentReport.classificationPartial || rawProbe.partial) };
      },
      () => {
        log("[stage] cleaning up (removing temporary inspection clip)…", "info");
        return safeAsync(() => removeTrackItem(project, sequence, trackItem));
      },
      log
    );
    const report = scanReport ?? { trackItem: null, components: [], scanStoppedEarly: true, rawProbe: null, partial: true };

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

    const cleanupOk = cleanupResult.ok && cleanupResult.value === true;

    if (scanError) {
      log("════ Diagnostic Inspector — finished with errors (cleanup still ran) ════", "error");
      return {
        ok: false,
        step: "scan",
        mogrtPath,
        error: String(scanError.message || scanError),
        generatedAt: new Date().toISOString(),
        ...report,
        cleanupOk,
      };
    }

    if (report.partial) {
      log(
        `════ Diagnostic Inspector — finished with PARTIAL results (${cancelToken.cancelled ? "cancelled" : "time budget exceeded"} — cleanup still ran) ════`,
        "warn"
      );
    } else {
      log("════ Diagnostic Inspector — finished ════", "info");
    }

    return {
      ok: true,
      mogrtPath,
      generatedAt: new Date().toISOString(),
      ...report,
      cleanupOk,
    };
  } finally {
    if (activeCancelToken === cancelToken) activeCancelToken = null;
  }
}
