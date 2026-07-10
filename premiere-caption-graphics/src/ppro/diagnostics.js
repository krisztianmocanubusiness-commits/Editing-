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
import { safe, safeAsync, safeResolve, resolveHostValue, toSafeString, describeValue } from "./introspect.js";

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

// Loose signals that a component is the MOGRT/graphic itself (or an
// After-Effects-authored property group inside one), gathered from Adobe
// forum threads discussing `matchName`s like "AE.ADBE Text" on MOGRT
// components (see docs/MOGRT_DIAGNOSTIC.md's research notes) — NOT confirmed
// against this project's own host output, since no such component has been
// observed yet as of this diagnostic tool's introduction.
const GRAPHIC_NAME_SIGNALS = ["graphic", "mogrt", "essential graphics", "ae.adbe", "video/graphic"];

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

  if (INTRINSIC_COMPONENT_NAMES.has(name)) {
    return { classification: "intrinsic", reason: `display name "${displayName}" matches a known intrinsic component` };
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
 * doc-comment for what this is trying to settle.
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 */
export async function deepDumpComponentChain(trackItem, log) {
  log("Diagnostic: reading full component chain (no name assumptions)…", "info");

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

  for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
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
      const valueTypeofName = startValue.ok ? typeof resolvedValue : "unreadable";
      const valueStr = startValue.ok
        ? describeValue(resolvedValue)
        : `unreadable (${startValue.error.message || startValue.error})`;
      const isTextLike = textLikeSignal(paramDisplayName, paramMatchNameResult.value);

      log(
        `  Param ${pi}: displayName="${paramDisplayName ?? "n/a"}", matchName=${paramMatchNameResult.value ?? "n/a"}` +
          `${paramMatchNameResult.source ? ` (via ${paramMatchNameResult.source})` : ""}, type=${paramType}, ` +
          `valueType=${valueTypeofName}, currentValue=${valueStr}${isTextLike ? " — TEXT-LIKE NAME" : ""}`,
        "info"
      );

      params.push({
        paramIndex: pi,
        displayName: paramDisplayName,
        matchName: paramMatchNameResult.value,
        matchNameSource: paramMatchNameResult.source,
        type: paramType,
        valueTypeofName,
        value: startValue.ok ? resolvedValue : null,
        valueReadError: startValue.ok ? null : String(startValue.error.message || startValue.error),
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
      `${byClass.intrinsic ?? 0} intrinsic, ${byClass["graphic-or-mogrt"] ?? 0} graphic-or-mogrt, ${byClass["effect-or-unknown"] ?? 0} effect-or-unknown.`,
    "success"
  );

  return { trackItem: trackItemInfo, components, scanStoppedEarly: false };
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

/**
 * Insert a .mogrt on the active sequence, run the deep component dump on it,
 * clean up the temporary clip, and return the full structured report. Reuses
 * the exact same insert/cleanup plumbing as templateInspector.js (see
 * ./mogrt.js) so this mode's insertion behavior can't drift from the regular
 * inspector's.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 */
export async function diagnoseMogrt(opts) {
  const { mogrtPath, log } = opts;

  log("════ Diagnostic Inspector — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected to diagnose.", "error");
    return { ok: false, step: "mogrt-path" };
  }

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

  log(`Inserting temporary inspection clip from: ${mogrtPath}`, "info");
  const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex));
  if (!insertResult.ok) {
    log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
    log("════ Diagnostic Inspector aborted — nothing to inspect ════", "error");
    return { ok: false, step: "insert" };
  }
  const trackItem = insertResult.value;
  log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

  // Cleanup is guaranteed even if the scan itself throws unexpectedly —
  // see runScanWithGuaranteedCleanup()'s doc comment for the failure mode
  // this fixes.
  const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
    () => deepDumpComponentChain(trackItem, log),
    () => safeAsync(() => removeTrackItem(project, sequence, trackItem)),
    log
  );
  const report = scanReport ?? { trackItem: null, components: [], scanStoppedEarly: true };

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

  log("════ Diagnostic Inspector — finished ════", "info");

  return {
    ok: true,
    mogrtPath,
    generatedAt: new Date().toISOString(),
    ...report,
    cleanupOk,
  };
}
