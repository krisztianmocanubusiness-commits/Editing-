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
 * CONFIRMED (see docs/MOGRT_DIAGNOSTIC.md): yes — a real host run found a
 * 4th component, `AE.ADBE Text`, with 22 params, sitting right after the
 * three intrinsic ones. `discoverComponents()` below is a deliberately
 * lightweight FIRST pass (index/matchName/displayName/paramCount only, no
 * method-probing, no per-field deep dive) so every phase downstream — the
 * classification report, the deep raw probe, AND the dedicated
 * `probeTextComponentDeep()` extraction pass — works from the exact same
 * discovered component list, in the exact same priority order (any
 * AE.ADBE Text component first), instead of each independently re-walking
 * the chain and risking disagreeing about what's even there.
 */
import { requireActiveProjectAndSequence, getSelectedRangeSeconds, listVideoTracks } from "./timelineRange.js";
import { insertMogrtAt, removeTrackItem } from "./mogrt.js";
import { safe, safeAsync, safeResolve, resolveHostValue, resolveHostValueDetailed, toSafeString } from "./introspect.js";
import {
  summarizeHostValue,
  formatSummaryForLog,
  probeHostObject,
  createScanBudget,
  DEFAULT_SCAN_BUDGET_MS,
  PROBE_CALL_TIMEOUT_MS,
} from "./deepProbe.js";

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
// 26.3, which reported exactly these three intrinsic components:
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
// a discovered custom control.
const INTRINSIC_MATCH_NAMES = new Set([
  "ae.adbe opacity",
  "ae.adbe motion",
  "ae.adbe transform",
  "ae.adbe time remapping",
  "ae.adbe crop",
  "ae.adbe channel volume",
  "ae.adbe graphic group",
]);

// CONFIRMED (see docs/MOGRT_DIAGNOSTIC.md): the real, genuine MOGRT text
// editing component's matchName, found via a real host run. Checked as an
// EXACT match (not a substring signal) and given its own classification
// tier — "text-editing" — distinct from both "intrinsic" and the generic
// "graphic-or-mogrt" bucket, so this specific, confirmed control is never
// lumped in with an unconfirmed heuristic guess.
const TEXT_COMPONENT_MATCH_NAMES = new Set(["ae.adbe text"]);

// Narrow, specific signals that a component is genuinely the MOGRT's own
// editable content — deliberately NOT including a bare "ae.adbe" (see
// INTRINSIC_MATCH_NAMES comment above for why that was wrong). "text" is
// kept as a fallback signal for any OTHER text-ish component that isn't an
// exact "AE.ADBE Text" match (e.g. a differently-matchNamed text layer).
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
 * @returns {{ classification: "text-editing"|"intrinsic"|"graphic-or-mogrt"|"effect-or-unknown", reason: string }}
 */
export function classifyComponent({ displayName, matchName }) {
  const name = safeLower(displayName);
  const match = safeLower(matchName);

  if (TEXT_COMPONENT_MATCH_NAMES.has(match) || TEXT_COMPONENT_MATCH_NAMES.has(name)) {
    return {
      classification: "text-editing",
      reason: `matchName "${matchName ?? displayName}" is AE.ADBE Text — confirmed via a real host run to be the MOGRT's genuine text/graphic editing component, not an intrinsic one (see docs/MOGRT_DIAGNOSTIC.md)`,
    };
  }

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
 * special-cased as always-synchronous. Tries a `getDisplayName()` method
 * too (not just the `.displayName` property), same two-attempt pattern as
 * readMatchName().
 *
 * @param {*} obj
 * @param {(message: string, level?: string) => void} [log]
 */
export async function readDisplayName(obj, log) {
  const attempts = [
    { source: "displayName (property)", fn: () => obj.displayName },
    { source: "getDisplayName() (method)", fn: () => (typeof obj.getDisplayName === "function" ? obj.getDisplayName() : undefined) },
  ];
  for (const attempt of attempts) {
    const raw = safe(attempt.fn);
    if (!raw.ok || raw.value === undefined || raw.value === null) continue;
    const resolved = await resolveHostValue(raw.value, null, { log, label: `displayName via ${attempt.source}` });
    const asString = toSafeString(resolved);
    if (asString !== null) return asString;
  }
  return null;
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
 * Best-effort param count reader: `component.getParamCount()` — CONFIRMED
 * to exist and work on a real host (returned 22 for the AE.ADBE Text
 * component). Used to bound per-component param loops precisely instead of
 * scanning blindly up to MAX_PARAM_SCAN; falls back to `null` (caller then
 * uses the blind bound) if unavailable or it fails.
 *
 * IMPORTANT: this is a read (a getter reporting a count), never confused
 * with actually calling `getParam()` itself without an index — see
 * NEVER_AUTO_CALL_EXACT_NAMES in src/ppro/deepProbe.js for why the latter
 * must never be auto-invoked.
 */
async function readParamCount(component, ci, log) {
  if (typeof component.getParamCount !== "function") return null;
  const result = await safeResolve(() => component.getParamCount(), { log, label: `component[${ci}].getParamCount()` });
  return result.ok && typeof result.value === "number" ? result.value : null;
}

/**
 * Lightweight, first-pass component discovery: for every component index,
 * reads ONLY its matchName, displayName, and paramCount (via
 * getParamCount()) — no method-probing, no per-param work. Deliberately
 * cheap so every later phase (classification detail, deep raw probe,
 * dedicated text extraction) can share this single result instead of each
 * re-walking the chain and risking a different, inconsistent view of what
 * components exist (confirmed real-host bug this fixes — see
 * docs/MOGRT_DIAGNOSTIC.md: the classification report and the raw probe
 * used to disagree on the component count).
 *
 * @param {*} chain
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function discoverComponents(chain, log, budget) {
  const components = [];
  let consecutiveMisses = 0;
  let partial = false;

  for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
    if (budget && budget.isExpired()) {
      log(`Component discovery stopped early at index ${ci}: ${budget.reason()}.`, "warn");
      partial = true;
      break;
    }
    const componentResult = await safeResolve(() => chain.getComponentAtIndex(ci), { log, label: `component[${ci}] (discovery)` });
    if (!componentResult.ok || !componentResult.value) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= CONSECUTIVE_MISS_TOLERANCE) break;
      continue;
    }
    consecutiveMisses = 0;
    const component = componentResult.value;

    const matchNameResult = await readMatchName(component, log);
    const displayName = await readDisplayName(component, log);
    const paramCount = await readParamCount(component, ci, log);
    const { classification, reason } = classifyComponent({ displayName, matchName: matchNameResult.value });

    log(
      `Discovered component ${ci}: matchName=${matchNameResult.value ?? "n/a"}, displayName=${displayName ?? "n/a"}, ` +
        `paramCount=${paramCount ?? "unknown"} → ${classification.toUpperCase()}`,
      classification === "text-editing" ? "success" : "info"
    );

    components.push({
      componentIndex: ci,
      component,
      matchName: matchNameResult.value,
      matchNameSource: matchNameResult.source,
      displayName,
      paramCount,
      classification,
      classificationReason: reason,
    });
  }

  return { components, partial };
}

/**
 * Reorders a discovered-component list so any `text-editing`-classified
 * component (i.e. AE.ADBE Text) comes first — per the task requirement to
 * probe it before Motion/Opacity/Crop/Graphic Group, so it gets first
 * claim on whatever scan budget is available. Stable otherwise (preserves
 * original relative order within each group).
 */
export function prioritizeTextFirst(components) {
  const text = components.filter((c) => c.classification === "text-editing");
  const rest = components.filter((c) => c.classification !== "text-editing");
  return [...text, ...rest];
}

// Stabilization defaults — CONFIRMED real-host behavior this exists for:
// Premiere apparently materializes a MOGRT's components asynchronously
// after insertion. A run whose deep probe was slow (repeated
// getValueAtTime timeouts, since fixed) happened to still find AE.ADBE
// Text at index 3; a run using the new, much faster discovery-first pass
// queried the chain too early and only ever saw the 3 intrinsic
// components that exist immediately. See docs/MOGRT_DIAGNOSTIC.md.
const STABILIZATION_INITIAL_DELAY_MS = 300;
const STABILIZATION_POLL_INTERVAL_MS = 250;
const STABILIZATION_MAX_WAIT_MS = 6000;
// Never declare "stable, give up" before this much time has passed, even
// if the signature looks unchanged early — evidence shows Text can appear
// late, so a too-early "it's stable" conclusion would be premature.
const STABILIZATION_MIN_WAIT_MS = 2000;
const STABILIZATION_STABLE_POLLS_REQUIRED = 2;

export const MOGRT_INIT_TIMEOUT_MESSAGE = "MOGRT component chain did not fully initialise before timeout.";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function componentSignature(components) {
  return components.map((c) => c.matchName ?? c.displayName ?? `component[${c.componentIndex}]`).join("|");
}

/**
 * Polls `trackItem.getComponentChain()` repeatedly — reacquiring a FRESH
 * chain object every single time, never reusing a previous one, per the
 * confirmed real-host finding that a MOGRT's components can still be
 * asynchronously materializing right after insertion — until either an
 * AE.ADBE Text component appears, the discovered component signature has
 * been unchanged for `stablePollsRequired` consecutive polls (and at least
 * `minWaitMs` has elapsed), or `maxWaitMs` is reached. Every poll is
 * itself just a `discoverComponents()` call (matchName/displayName/
 * paramCount only — no per-param deep-probing during stabilization).
 *
 * Cooperatively cancellable via `cancelToken` (same shared token as the
 * rest of a diagnostic run), checked between polls.
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @param {Object} [opts]
 * @param {number} [opts.initialDelayMs]
 * @param {number} [opts.pollIntervalMs]
 * @param {number} [opts.maxWaitMs]
 * @param {number} [opts.minWaitMs]
 * @param {number} [opts.stablePollsRequired]
 * @param {{ cancelled: boolean }|null} [opts.cancelToken]
 * @param {number} [opts.startedAt] Override for Date.now() at the start — test-only.
 * @param {(ms: number) => Promise<void>} [opts.sleepFn] Override for the wait between polls — test-only.
 * @returns {Promise<{ discovery: { components: Array, partial: boolean }, timeline: Array, textFound: boolean, elapsedMs: number }>}
 */
export async function stabilizeComponentChain(trackItem, log, opts = {}) {
  const {
    initialDelayMs = STABILIZATION_INITIAL_DELAY_MS,
    pollIntervalMs = STABILIZATION_POLL_INTERVAL_MS,
    maxWaitMs = STABILIZATION_MAX_WAIT_MS,
    minWaitMs = STABILIZATION_MIN_WAIT_MS,
    stablePollsRequired = STABILIZATION_STABLE_POLLS_REQUIRED,
    cancelToken = null,
    startedAt = Date.now(),
    sleepFn = sleep,
  } = opts;

  const timeline = [];
  let attempt = 0;
  let lastSignature = null;
  let stableCount = 0;
  let textFound = false;
  let finalDiscovery = { components: [], partial: false };

  for (;;) {
    attempt += 1;
    const elapsedMs = Date.now() - startedAt;

    const chainResult = await safeResolve(() => trackItem.getComponentChain(), {
      log,
      label: `getComponentChain() (stabilization attempt ${attempt})`,
    });
    let discovery = { components: [], partial: false };
    if (chainResult.ok && chainResult.value) {
      discovery = await discoverComponents(chainResult.value, log, undefined);
    }
    finalDiscovery = discovery;

    const names = discovery.components.map((c) => c.matchName ?? c.displayName ?? `component[${c.componentIndex}]`);
    timeline.push({ elapsedMs, attempt, componentCount: discovery.components.length, components: names });

    const hasText = discovery.components.some((c) => c.classification === "text-editing");
    log(
      `[stage] waiting for MOGRT components — attempt ${attempt}, ${discovery.components.length} found` + (hasText ? " (AE.ADBE Text present)" : ""),
      hasText ? "success" : "info"
    );

    if (hasText) {
      textFound = true;
      log("[stage] AE.ADBE Text discovered.", "success");
      break;
    }

    if (cancelToken && cancelToken.cancelled) {
      log("Component stabilization cancelled.", "warn");
      break;
    }

    const signature = componentSignature(discovery.components);
    if (signature === lastSignature) {
      stableCount += 1;
    } else {
      stableCount = 0;
      lastSignature = signature;
    }

    const elapsedNow = Date.now() - startedAt;
    if (elapsedNow >= maxWaitMs) {
      log(`${MOGRT_INIT_TIMEOUT_MESSAGE} No AE.ADBE Text component appeared within ${maxWaitMs}ms. A previous scan already proved this MOGRT has one — this does not mean it doesn't; it may just need more time or another attempt.`, "warn");
      break;
    }
    if (elapsedNow >= minWaitMs && stableCount >= stablePollsRequired) {
      log(`Component signature stable for ${stableCount} consecutive polls after ${elapsedNow}ms — stopping wait (no AE.ADBE Text found yet).`, "warn");
      break;
    }

    const wantedWaitMs = attempt === 1 ? initialDelayMs : pollIntervalMs;
    const remainingMs = Math.max(0, maxWaitMs - (Date.now() - startedAt));
    await sleepFn(Math.min(wantedWaitMs, remainingMs));
  }

  return { discovery: finalDiscovery, timeline, textFound, elapsedMs: Date.now() - startedAt };
}

/**
 * Builds the classification/detail report (per-component displayName/
 * matchName/classification, per-param displayName/matchName/type/value)
 * from an already-discovered, priority-ordered component list — see
 * discoverComponents(). Reported components are re-sorted back to original
 * index order for readability before returning, even though they were
 * probed in priority order internally.
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {Array} orderedComponents From discoverComponents() + prioritizeTextFirst().
 * @param {boolean} discoveryPartial Whether the discovery pass itself stopped early.
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function buildComponentDetailReport(trackItem, orderedComponents, discoveryPartial, log, budget) {
  const typeNameResult = await safeResolve(() => trackItem.constructor?.name, { log, label: "trackItem type" });
  const trackItemMatchName = await readMatchName(trackItem, log);
  const trackItemInfo = {
    typeName: (typeNameResult.ok && typeNameResult.value) || "unknown",
    matchName: trackItemMatchName.value,
  };
  log(`TrackItem: type=${trackItemInfo.typeName}, matchName=${trackItemInfo.matchName ?? "n/a"}`, "info");

  const components = [];
  let partial = discoveryPartial;

  for (const info of orderedComponents) {
    if (budget && budget.isExpired()) {
      log(`Component detail scan stopped early before component ${info.componentIndex}: ${budget.reason()}.`, "warn");
      partial = true;
      break;
    }
    const { componentIndex: ci, component, matchName, matchNameSource, displayName, classification, classificationReason, paramCount } = info;

    log(
      `Component ${ci}: displayName="${displayName ?? "n/a"}", matchName=${matchName ?? "n/a"} → classified as ${classification.toUpperCase()} (${classificationReason})`,
      classification === "text-editing" || classification === "graphic-or-mogrt" ? "success" : "info"
    );

    const params = [];
    let paramMisses = 0;
    const upperBound = typeof paramCount === "number" ? paramCount : MAX_PARAM_SCAN;
    for (let pi = 0; pi < upperBound; pi++) {
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
      const startValue = await safeResolve(() => param.getStartValue(), { log, label: `component[${ci}].param[${pi}].getStartValue()` });
      let valueSummary;
      if (!startValue.ok) {
        valueSummary = { kind: "unreadable", error: startValue.timedOut ? "getStartValue() timed out" : String(startValue.error?.message || startValue.error) };
      } else {
        const resolved = await resolveHostValueDetailed(startValue.value, { log, label: `component[${ci}].param[${pi}].value`, timeoutMs: PROBE_CALL_TIMEOUT_MS });
        valueSummary = resolved.ok
          ? summarizeHostValue(resolved.value)
          : { kind: "unreadable", error: resolved.timedOut ? "value resolution timed out" : String(resolved.error?.message || resolved.error) };
      }
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
      matchName,
      matchNameSource,
      classification,
      classificationReason,
      paramCount: params.length,
      declaredParamCount: paramCount ?? null,
      params,
    });
  }

  // Report in original index order for readability, even though probing
  // happened in priority (text-first) order above.
  components.sort((a, b) => a.componentIndex - b.componentIndex);

  const byClass = components.reduce((acc, c) => {
    acc[c.classification] = (acc[c.classification] || 0) + 1;
    return acc;
  }, {});
  log(
    `Diagnostic scan complete: ${components.length} component(s) — ` +
      `${byClass.intrinsic ?? 0} intrinsic, ${byClass["text-editing"] ?? 0} text-editing, ${byClass["graphic-or-mogrt"] ?? 0} graphic-or-mogrt, ${byClass["effect-or-unknown"] ?? 0} effect-or-unknown.` +
      (partial ? " (STOPPED EARLY — time budget or cancellation, see above)" : ""),
    partial ? "warn" : "success"
  );

  return { trackItem: trackItemInfo, components, scanStoppedEarly: false, classificationPartial: partial };
}

/**
 * Self-contained convenience wrapper: fetches its own component chain
 * ONCE (no stabilization wait — see stabilizeComponentChain(), which
 * diagnoseMogrt() uses instead), discovers + prioritizes components, and
 * builds the detail report — for standalone use. diagnoseMogrt() below
 * does NOT call this; it stabilizes first, then shares one post-
 * stabilization discovery result across the classification report, the
 * raw probe, and the dedicated text-component pass instead, to guarantee
 * all three agree on what components exist.
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function deepDumpComponentChain(trackItem, log, budget) {
  log("[stage] reading track item — discovering components (lightweight pass)…", "info");
  const chainResult = await safeResolve(() => trackItem.getComponentChain(), { log, label: "getComponentChain()" });
  const typeNameResult = await safeResolve(() => trackItem.constructor?.name, { log, label: "trackItem type" });
  const trackItemMatchName = await readMatchName(trackItem, log);
  const trackItemInfo = { typeName: (typeNameResult.ok && typeNameResult.value) || "unknown", matchName: trackItemMatchName.value };

  if (!chainResult.ok || !chainResult.value) {
    log(`✗ getComponentChain() failed: ${chainResult.ok ? "returned nothing" : (chainResult.error.message || chainResult.error)}`, "error");
    return { trackItem: trackItemInfo, components: [], scanStoppedEarly: true, classificationPartial: false };
  }

  const discovery = await discoverComponents(chainResult.value, log, budget);
  const ordered = prioritizeTextFirst(discovery.components);
  return buildComponentDetailReport(trackItem, ordered, discovery.partial, log, budget);
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
 * The generic deep raw probe body: trackItem, project item, and every
 * discovered component/param's full shape (Object.keys,
 * Object.getOwnPropertyNames, prototype method/property names,
 * constructor, safely-called zero-arg getters — see
 * src/ppro/deepProbe.js's probeHostObject()). Driven by an already-
 * discovered, priority-ordered component list (see discoverComponents()/
 * prioritizeTextFirst()) rather than re-walking the chain, so this always
 * agrees with the classification report on what components exist.
 *
 * NOTE: `getValueAtTime()` is never auto-called here (or anywhere else) —
 * see NEVER_AUTO_CALL_EXACT_NAMES in src/ppro/deepProbe.js. This was the
 * confirmed cause of the scan hanging/burning its whole budget before
 * reaching AE.ADBE Text (see docs/MOGRT_DIAGNOSTIC.md).
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {Array} orderedComponents
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function probeComponentsDeep(trackItem, orderedComponents, log, budget) {
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

  const components = [];
  let partial = false;
  const totalComponents = orderedComponents.length;

  for (let idx = 0; idx < orderedComponents.length; idx++) {
    if (budget && budget.isExpired()) {
      log(`Raw probe stopped early before component ${idx + 1}/${totalComponents}: ${budget.reason()}.`, "warn");
      partial = true;
      break;
    }
    const info = orderedComponents[idx];
    const { componentIndex: ci, component, paramCount } = info;
    log(`[stage] probing component ${idx + 1}/${totalComponents} (index ${ci}, ${info.classification})…`, "info");
    const componentProbe = await probeHostObject(component, `component[${ci}]`, log, budget);

    const params = [];
    let paramMisses = 0;
    const upperBound = typeof paramCount === "number" ? paramCount : MAX_PARAM_SCAN;
    for (let pi = 0; pi < upperBound; pi++) {
      if (budget && budget.isExpired()) {
        log(`Raw probe stopped early before param ${pi} on component ${ci}: ${budget.reason()}.`, "warn");
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
      log(`  [stage] probing parameter ${pi + 1}${paramCount ? `/${paramCount}` : ""} on component ${ci}…`, "info");
      const paramProbe = await probeHostObject(param, `component[${ci}].param[${pi}]`, log, budget);

      const startValueResult = await safeResolve(() => param.getStartValue(), { log, label: `component[${ci}].param[${pi}].getStartValue()` });
      const startValueProbe = startValueResult.ok
        ? await probeHostObject(startValueResult.value, `component[${ci}].param[${pi}].getStartValue()`, log, budget)
        : { label: `component[${ci}].param[${pi}].getStartValue()`, exists: false, error: String(startValueResult.error?.message || startValueResult.error) };

      params.push({ paramIndex: pi, probe: paramProbe, startValueProbe });
    }

    components.push({ componentIndex: ci, probe: componentProbe, params });
    if (partial) break;
  }

  components.sort((a, b) => a.componentIndex - b.componentIndex);

  log("[stage] serializing raw probe results…", "info");
  log(
    `Raw probe complete: ${components.length} component(s) probed, ${components.reduce((sum, c) => sum + c.params.length, 0)} param(s) probed in depth.` +
      (partial ? " (STOPPED EARLY — time budget or cancellation)" : ""),
    partial ? "warn" : "success"
  );

  return { trackItemProbe, projectItemProbe, components, partial };
}

/**
 * Self-contained convenience wrapper around probeComponentsDeep() — fetches
 * its own chain/discovery, for standalone use. diagnoseMogrt() shares one
 * discovery pass instead (see deepDumpComponentChain()'s doc-comment).
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @param {Object} [opts]
 * @param {ReturnType<typeof createScanBudget>} [opts.budget]
 */
export async function deepProbeMogrt(trackItem, log, opts = {}) {
  const { budget } = opts;
  log("[stage] probing deeper (raw host-object probe): trackItem, projectItem, every component/param, resolved values…", "info");
  if (budget && budget.isExpired()) {
    log(`Raw probe skipped entirely: ${budget.reason()} before it could start.`, "warn");
    return { trackItemProbe: { label: "trackItem", skipped: true, reason: budget.reason() }, projectItemProbe: { label: "trackItem.projectItem", skipped: true, reason: budget.reason() }, components: [], partial: true };
  }
  const chainResult = await safeResolve(() => trackItem.getComponentChain(), { log, label: "getComponentChain() (raw probe)" });
  if (!chainResult.ok || !chainResult.value) {
    return { trackItemProbe: await probeHostObject(trackItem, "trackItem", log, budget), projectItemProbe: { label: "trackItem.projectItem", exists: false }, components: [], partial: false };
  }
  const discovery = await discoverComponents(chainResult.value, log, budget);
  const ordered = prioritizeTextFirst(discovery.components);
  const result = await probeComponentsDeep(trackItem, ordered, log, budget);
  return { ...result, partial: result.partial || discovery.partial };
}

/**
 * Reads a single field (own or inherited) the same way deepProbe.js's
 * probeObjectShape() does — a plain property access naturally walks the
 * prototype chain, so this correctly reads an inherited accessor (e.g.
 * `Keyframe.prototype.value`) without any special handling.
 */
async function readTextParamField(obj, name, label, log) {
  const raw = safe(() => obj[name]);
  if (!raw.ok || raw.value === undefined) return null;
  const resolved = await resolveHostValueDetailed(raw.value, { log, label: `${label}.${name}`, timeoutMs: PROBE_CALL_TIMEOUT_MS });
  if (!resolved.ok) {
    return { errored: true, timedOut: Boolean(resolved.timedOut), message: resolved.timedOut ? "timed out" : String(resolved.error?.message || resolved.error) };
  }
  return { errored: false, summary: summarizeHostValue(resolved.value) };
}

/**
 * Dedicated, focused extraction pass for exactly one component — meant for
 * the AE.ADBE Text component once discovery finds it. Per param, reads:
 * displayName, the getStartValue() result's constructor name, whether
 * isTimeVarying()/areKeyframesSupported() are safely callable (best
 * effort, failures recorded but not fatal), and — critically — that
 * getStartValue() result's INHERITED `.value`/`.position` accessor
 * properties (the actual real number/point/colour/text value; see
 * deepProbe.js's probeObjectShape() doc-comment for why these are
 * inherited, not own, properties on Keyframe/PointKeyframe).
 *
 * Deliberately narrow and un-generic (no method-probing beyond the two
 * named predicates, no walking the param's whole prototype chain) so a
 * 22-param text component completes quickly — the whole point of this
 * pass existing separately from the generic probeComponentsDeep() above.
 *
 * @param {{ componentIndex: number, component: *, matchName: string|null, displayName: string|null, paramCount: number|null }} componentInfo
 * @param {(message: string, level?: string) => void} log
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function probeTextComponentDeep(componentInfo, log, budget) {
  const { componentIndex, component, matchName, displayName, paramCount } = componentInfo;
  const result = { componentIndex, matchName, displayName, paramCount, params: [], partial: false };

  const upperBound = typeof paramCount === "number" ? paramCount : MAX_PARAM_SCAN;
  let consecutiveMisses = 0;

  for (let pi = 0; pi < upperBound; pi++) {
    if (budget && budget.isExpired()) {
      log(`Text component param scan stopped early at param ${pi}${paramCount ? `/${paramCount}` : ""}: ${budget.reason()}.`, "warn");
      result.partial = true;
      break;
    }
    const paramResult = await safeResolve(() => component.getParam(pi), { log, label: `textComponent.param[${pi}]` });
    if (!paramResult.ok || !paramResult.value) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= CONSECUTIVE_MISS_TOLERANCE) break;
      continue;
    }
    consecutiveMisses = 0;
    const param = paramResult.value;
    const entry = await probeTextParam(param, pi, log);
    result.params.push(entry);
    log(
      `  [stage] Text param ${pi + 1}${paramCount ? `/${paramCount}` : ""}: displayName="${entry.displayName ?? "n/a"}", ` +
        `startValueConstructor=${entry.startValueConstructor ?? "n/a"}` +
        `${entry.value ? `, value=${formatSummaryForLog(entry.value)}` : ""}` +
        `${entry.position ? `, position=${formatSummaryForLog(entry.position)}` : ""}`,
      entry.timedOut ? "warn" : "success"
    );
  }

  log(
    `Text component probe complete: ${result.params.length}${paramCount ? `/${paramCount}` : ""} param(s) probed.` +
      (result.partial ? " (STOPPED EARLY)" : ""),
    result.partial ? "warn" : "success"
  );

  return result;
}

async function probeTextParam(param, paramIndex, log) {
  const errors = [];
  const displayName = await readDisplayName(param, log);

  const constructorResult = await safeResolve(() => param.constructor?.name, { log, label: `textComponent.param[${paramIndex}].constructor` });
  const paramConstructorName = (constructorResult.ok && constructorResult.value) || null;

  // isTimeVarying()/areKeyframesSupported(): genuine zero-arg predicates by
  // name and convention, called defensively ("only if safely callable" —
  // feature-detected, and any failure is recorded rather than aborting the
  // rest of this param's probe).
  let isTimeVarying = null;
  if (typeof param.isTimeVarying === "function") {
    const r = await safeResolve(() => param.isTimeVarying(), { log, label: `textComponent.param[${paramIndex}].isTimeVarying()` });
    if (r.ok) isTimeVarying = r.value;
    else errors.push(`isTimeVarying(): ${r.timedOut ? "timed out" : String(r.error?.message || r.error)}`);
  }

  let areKeyframesSupported = null;
  if (typeof param.areKeyframesSupported === "function") {
    const r = await safeResolve(() => param.areKeyframesSupported(), { log, label: `textComponent.param[${paramIndex}].areKeyframesSupported()` });
    if (r.ok) areKeyframesSupported = r.value;
    else errors.push(`areKeyframesSupported(): ${r.timedOut ? "timed out" : String(r.error?.message || r.error)}`);
  }

  const startValueResult = await safeResolve(() => param.getStartValue(), { log, label: `textComponent.param[${paramIndex}].getStartValue()` });
  let startValueConstructor = null;
  let value = null;
  let position = null;
  let timedOut = false;

  if (!startValueResult.ok) {
    if (startValueResult.timedOut) {
      timedOut = true;
      errors.push("getStartValue(): timed out");
    } else {
      errors.push(`getStartValue(): ${String(startValueResult.error?.message || startValueResult.error)}`);
    }
  } else {
    const startValue = startValueResult.value;
    const ctorResult = await safeResolve(() => startValue?.constructor?.name, { log, label: `textComponent.param[${paramIndex}].getStartValue().constructor` });
    startValueConstructor = (ctorResult.ok && ctorResult.value) || null;

    if (startValue !== null && startValue !== undefined && (typeof startValue === "object" || typeof startValue === "function")) {
      // `.value`/`.position` are INHERITED accessor properties on the
      // Keyframe/PointKeyframe prototype (confirmed via a real host run —
      // see docs/MOGRT_DIAGNOSTIC.md), not own-enumerable properties on the
      // instance. A plain property read still walks the prototype chain
      // and invokes the getter correctly — see readTextParamField().
      const valueField = await readTextParamField(startValue, "value", `textComponent.param[${paramIndex}].getStartValue()`, log);
      if (valueField) {
        if (valueField.errored) {
          if (valueField.timedOut) timedOut = true;
          errors.push(`.value: ${valueField.message}`);
        } else {
          value = valueField.summary;
        }
      }

      const positionField = await readTextParamField(startValue, "position", `textComponent.param[${paramIndex}].getStartValue()`, log);
      if (positionField) {
        if (positionField.errored) {
          if (positionField.timedOut) timedOut = true;
          errors.push(`.position: ${positionField.message}`);
        } else {
          position = positionField.summary;
        }
      }
    }
  }

  return {
    paramIndex,
    displayName,
    startValueConstructor,
    paramConstructorName,
    isTimeVarying,
    areKeyframesSupported,
    value,
    position,
    errors,
    timedOut,
  };
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
 * Insert a .mogrt on the active sequence, WAIT for its component chain to
 * stabilize (see stabilizeComponentChain() — confirmed real-host behavior:
 * Premiere can still be asynchronously materializing a MOGRT's components
 * for a couple of seconds after insertion, so querying immediately can
 * genuinely under-report what's there), then run the classification detail
 * report, the deep raw probe, and (if an AE.ADBE Text component was found)
 * the dedicated text extraction pass — all from that ONE post-stabilization
 * discovery, in priority order (text first) — clean up the temporary clip,
 * and return the full structured report. Reuses the exact same insert/
 * cleanup plumbing as templateInspector.js (see ./mogrt.js) so this mode's
 * insertion behavior can't drift from the regular inspector's.
 *
 * Two DELIBERATELY SEPARATE time budgets: up to ~6s (stabilization's own
 * internal max wait) for Premiere to finish materializing components, then
 * a FRESH `opts.scanBudgetMs` (default DEFAULT_SCAN_BUDGET_MS, ~12s) for
 * the actual probing — so a slow MOGRT startup never eats into the budget
 * meant for reading its params. Bounded to finish regardless of how much
 * there is to probe or whether anything in the probed object graph hangs —
 * see src/ppro/deepProbe.js's module doc-comment for the three independent
 * bounds (per-call timeout, shared scan budget, structural caps) that make
 * the probing phase's guarantee hold.
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
  // never linger and "cancel" a future, unrelated run. Checked throughout
  // BOTH the stabilization wait and the deep-probe budget below, so Cancel
  // works during either phase.
  const cancelToken = { cancelled: false };
  activeCancelToken = cancelToken;

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

    // Cleanup is guaranteed even if any phase throws OR either budget/
    // cancellation cuts it short — see runScanWithGuaranteedCleanup()'s doc
    // comment for the crash failure mode, and deepProbe.js's module
    // doc-comment for the hang failure mode. The stabilization wait and the
    // deep-probe budget are DELIBERATELY SEPARATE (see stabilizeComponentChain()
    // above) so time spent waiting for Premiere to finish materializing
    // components never eats into the budget actually used for probing —
    // every phase after stabilization shares one discovery result and one
    // probe budget, so the classification report and raw probe can't
    // disagree on what components exist.
    const { report: scanReport, scanError, cleanupResult } = await runScanWithGuaranteedCleanup(
      async () => {
        const typeNameResult = await safeResolve(() => trackItem.constructor?.name, { log, label: "trackItem type" });
        const trackItemMatchName = await readMatchName(trackItem, log);
        const trackItemInfo = { typeName: (typeNameResult.ok && typeNameResult.value) || "unknown", matchName: trackItemMatchName.value };
        log(`TrackItem: type=${trackItemInfo.typeName}, matchName=${trackItemInfo.matchName ?? "n/a"}`, "info");

        log("[stage] waiting for MOGRT components to finish initializing…", "info");
        const stabilization = await stabilizeComponentChain(trackItem, log, { cancelToken });
        const discovery = stabilization.discovery;
        const ordered = prioritizeTextFirst(discovery.components);
        const textInfo = discovery.components.find((c) => c.classification === "text-editing") ?? null;

        // A fresh, separate budget for the deep-probe phase, starting its
        // clock now — the stabilization wait above does NOT consume any of
        // it, per the task that required this split.
        const probeBudget = createScanBudget({ totalMs: scanBudgetMs, cancelToken });

        let textComponentProbe = null;
        if (textInfo) {
          log(
            `[stage] AE.ADBE Text component found at index ${textInfo.componentIndex} (${textInfo.paramCount ?? "?"} params declared) — probing it first, with priority.`,
            "success"
          );
          textComponentProbe = await probeTextComponentDeep(textInfo, log, probeBudget);
        } else if (stabilization.timeline.length > 0 && discovery.components.length > 0) {
          // Components exist, just none classified as text-editing — a
          // genuine (if not fully certain) "not found this time" result.
          log("No AE.ADBE Text component was found among the components that stabilized within the wait window.", "warn");
        }
        // If discovery.components.length === 0 entirely, stabilizeComponentChain
        // already logged the exact required MOGRT_INIT_TIMEOUT_MESSAGE.

        const componentReport = await buildComponentDetailReport(trackItem, ordered, discovery.partial, log, probeBudget);
        const rawProbeInner = await probeComponentsDeep(trackItem, ordered, log, probeBudget);
        const rawProbe = { ...rawProbeInner, partial: rawProbeInner.partial || discovery.partial };

        log("[stage] serializing results…", "info");

        return {
          ...componentReport,
          rawProbe,
          textComponentProbe,
          componentDiscoveryTimeline: stabilization.timeline,
          stabilizationTimedOut: !stabilization.textFound,
          partial: Boolean(componentReport.classificationPartial || rawProbe.partial || (textComponentProbe && textComponentProbe.partial)),
        };
      },
      () => {
        log("[stage] cleaning up (removing temporary inspection clip)…", "info");
        return safeAsync(() => removeTrackItem(project, sequence, trackItem));
      },
      log
    );
    const report = scanReport ?? {
      trackItem: null,
      components: [],
      scanStoppedEarly: true,
      classificationPartial: false,
      rawProbe: null,
      textComponentProbe: null,
      componentDiscoveryTimeline: [],
      stabilizationTimedOut: true,
      partial: true,
    };

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
