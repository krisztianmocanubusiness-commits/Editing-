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
import { safe, safeAsync, describeValue } from "./introspect.js";

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

/**
 * @param {{ displayName?: string|null, matchName?: string|null }} info
 * @returns {{ classification: "intrinsic"|"graphic-or-mogrt"|"effect-or-unknown", reason: string }}
 */
export function classifyComponent({ displayName, matchName }) {
  const name = (displayName || "").trim().toLowerCase();
  const match = (matchName || "").trim().toLowerCase();

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

/** Best-effort matchName reader: tries every plausible accessor shape and reports which (if any) worked. */
export function readMatchName(obj) {
  const attempts = [
    { source: "matchName (property)", fn: () => obj.matchName },
    { source: "getMatchName() (method)", fn: () => (typeof obj.getMatchName === "function" ? obj.getMatchName() : undefined) },
  ];
  for (const attempt of attempts) {
    const result = safe(attempt.fn);
    if (result.ok && result.value !== undefined && result.value !== null) {
      return { value: result.value, source: attempt.source };
    }
  }
  return { value: null, source: null };
}

export function textLikeSignal(displayName, matchName) {
  const name = `${displayName || ""} ${matchName || ""}`.toLowerCase();
  return name.includes("text") || name.includes("source text");
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

  const trackItemInfo = {
    typeName: safe(() => trackItem.constructor?.name).value ?? "unknown",
    matchName: readMatchName(trackItem).value,
  };
  log(`TrackItem: type=${trackItemInfo.typeName}, matchName=${trackItemInfo.matchName ?? "n/a"}`, "info");

  const chainResult = await safeAsync(() => trackItem.getComponentChain());
  if (!chainResult.ok) {
    log(`✗ getComponentChain() threw: ${chainResult.error.message || chainResult.error}`, "error");
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
    const componentResult = safe(() => chain.getComponentAtIndex(ci));
    if (!componentResult.ok || !componentResult.value) {
      consecutiveMisses += 1;
      log(
        `Component index ${ci}: ${componentResult.ok ? "no component returned" : `threw (${componentResult.error.message || componentResult.error})`} ` +
          `(${consecutiveMisses}/${CONSECUTIVE_MISS_TOLERANCE} consecutive misses before stopping)`,
        "info"
      );
      if (consecutiveMisses >= CONSECUTIVE_MISS_TOLERANCE) break;
      continue;
    }
    consecutiveMisses = 0;
    const component = componentResult.value;

    const displayName = safe(() => component.displayName).value ?? null;
    const matchNameResult = readMatchName(component);
    const { classification, reason } = classifyComponent({ displayName, matchName: matchNameResult.value });

    log(
      `Component ${ci}: displayName="${displayName ?? "n/a"}", matchName=${matchNameResult.value ?? "n/a"}` +
        `${matchNameResult.source ? ` (via ${matchNameResult.source})` : ""} → classified as ${classification.toUpperCase()} (${reason})`,
      classification === "graphic-or-mogrt" ? "success" : "info"
    );

    const params = [];
    let paramMisses = 0;
    for (let pi = 0; pi < MAX_PARAM_SCAN; pi++) {
      const paramResult = safe(() => component.getParam(pi));
      if (!paramResult.ok || !paramResult.value) {
        paramMisses += 1;
        if (paramMisses >= 1) break; // params are dense within a component; one miss ends it (unlike the component-level scan)
        continue;
      }
      const param = paramResult.value;

      const paramDisplayName = safe(() => param.displayName).value ?? null;
      const paramMatchNameResult = readMatchName(param);
      const paramType = safe(() => param.type).value ?? safe(() => param.paramType).value ?? "unknown";
      const startValue = await safeAsync(() => param.getStartValue());
      const valueTypeofName = startValue.ok ? typeof startValue.value : "unreadable";
      const valueStr = startValue.ok
        ? describeValue(startValue.value)
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
        value: startValue.ok ? startValue.value : null,
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

  const report = await deepDumpComponentChain(trackItem, log);

  const cleanupResult = await safeAsync(() => removeTrackItem(project, sequence, trackItem));
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

  log("════ Diagnostic Inspector — finished ════", "info");

  return {
    ok: true,
    mogrtPath,
    generatedAt: new Date().toISOString(),
    ...report,
    cleanupOk: cleanupResult.ok && cleanupResult.value === true,
  };
}
