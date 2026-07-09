/**
 * Host validation pass for the Premiere scripting layer.
 *
 * This deliberately duplicates a little logic from applyCaptions.js /
 * mogrtContract.js rather than reusing the preset pipeline: the point of
 * this module is to be a *minimal, isolated* path from "click a button" to
 * "one styled MOGRT on the timeline" with maximum logging at every step, so
 * a human watching the UDT console can see exactly which Premiere UXP API
 * calls actually work on their installed host and which don't. Nothing
 * here is allowed to silently assume success — every call is wrapped and
 * its real return value / thrown error is logged.
 */
import { requireActiveProjectAndSequence, getSelectedRangeSeconds, listVideoTracks } from "./timelineRange.js";
import { insertMogrtAt, setTrackItemEnd } from "./mogrt.js";
import { tickToSec } from "./time.js";
import { setParamValue, coerceValue } from "./componentParams.js";

const TEXT_CANDIDATES = ["Caption Text", "Source Text", "Text"];
const FONT_SIZE_CANDIDATES = ["Font Size", "Size"];
const FILL_COLOR_CANDIDATES = ["Fill Color", "Fill Colour", "Color", "Colour"];
const BG_OPACITY_CANDIDATES = ["Background Opacity", "Background Enabled", "Opacity"];

const MAX_COMPONENT_SCAN = 64;
const MAX_PARAM_SCAN = 64;

function safe(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

async function safeAsync(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function describe(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Best-effort playhead read. Adobe's public sample panel does not
 * demonstrate a CTI/playhead getter on Sequence, so this tries a few
 * plausible method names, logs exactly which one (if any) worked, and
 * falls back to the sequence's in-point / 0 rather than guessing silently.
 */
async function resolveStartTimeSec(sequence, fallbackSec, log) {
  const candidateMethods = ["getPlayerPosition", "getPlayheadPosition", "getCurrentTime"];
  for (const name of candidateMethods) {
    if (typeof sequence[name] !== "function") continue;
    const result = await safeAsync(() => sequence[name]());
    if (result.ok) {
      const sec = tickToSec(result.value);
      log(`Playhead resolved via sequence.${name}() → ${sec.toFixed(3)}s`, "success");
      return sec;
    }
    log(`sequence.${name}() exists but threw: ${result.error.message || result.error}`, "warn");
  }
  log(
    `No working playhead getter found on Sequence (tried: ${candidateMethods.join(", ")}). ` +
      `Falling back to ${fallbackSec.toFixed(3)}s (selected range / sequence start).`,
    "warn"
  );
  return fallbackSec;
}

/**
 * Walk every component/param on a track item and log what's actually
 * there — names, best-effort "type", and current value where readable.
 * Scan bounds are defensive (see mogrt.js findExposedParam for the same
 * caveat): no explicit count method appears in Adobe's public sample.
 */
async function dumpComponentChain(trackItem, log) {
  log("Reading component chain…", "info");
  const chainResult = await safeAsync(() => trackItem.getComponentChain());
  if (!chainResult.ok) {
    log(`✗ getComponentChain() threw: ${chainResult.error.message || chainResult.error}`, "error");
    return [];
  }
  const chain = chainResult.value;
  if (!chain) {
    log("✗ getComponentChain() returned nothing.", "error");
    return [];
  }

  const discovered = [];
  for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
    const componentResult = safe(() => chain.getComponentAtIndex(ci));
    if (!componentResult.ok) {
      log(`Component scan stopped at index ${ci}: ${componentResult.error.message || componentResult.error}`, "info");
      break;
    }
    const component = componentResult.value;
    if (!component) {
      log(`Component scan stopped at index ${ci}: no component returned.`, "info");
      break;
    }

    const name = safe(() => component.displayName).value ?? safe(() => component.matchName).value ?? `Component[${ci}]`;
    log(`Component ${ci}: "${name}"`, "info");

    for (let pi = 0; pi < MAX_PARAM_SCAN; pi++) {
      const paramResult = safe(() => component.getParam(pi));
      if (!paramResult.ok || !paramResult.value) break;
      const param = paramResult.value;

      const paramName = safe(() => param.displayName).value ?? `Param[${pi}]`;
      const paramType = safe(() => param.type).value ?? safe(() => param.paramType).value ?? "unknown";
      const startValue = await safeAsync(() => param.getStartValue());
      const currentValueStr = startValue.ok ? describe(startValue.value) : `unreadable (${startValue.error.message || startValue.error})`;

      log(`  Param ${pi}: "${paramName}" — type=${paramType}, currentValue=${currentValueStr}`, "info");
      discovered.push({ componentIndex: ci, paramIndex: pi, name: paramName, type: paramType, param, component });
    }
  }

  log(`Component/param scan complete: ${discovered.length} exposed param(s) found.`, discovered.length ? "success" : "warn");
  return discovered;
}

function findByCandidates(discovered, candidateNames) {
  for (const name of candidateNames) {
    const hit = discovered.find((d) => d.name === name);
    if (hit) return hit;
  }
  return null;
}

/** Set one param by trying a list of plausible display names, logging exactly what happened. */
function trySetByCandidates(project, discovered, candidateNames, kind, value, label, log) {
  const hit = findByCandidates(discovered, candidateNames);
  if (!hit) {
    log(`✗ ${label}: no param matched (tried: ${candidateNames.join(", ")})`, "error");
    return { ok: false, tried: candidateNames };
  }
  const attemptResult = safe(() => setParamValue(project, hit.param, kind, value));
  if (!attemptResult.ok) {
    log(`✗ ${label}: setParamValue("${hit.name}") threw: ${attemptResult.error.message || attemptResult.error}`, "error");
    return { ok: false, paramName: hit.name, error: String(attemptResult.error) };
  }
  if (attemptResult.value) {
    log(`✓ ${label}: set "${hit.name}" (kind=${kind}) → ${describe(coerceValue(kind, value))}`, "success");
    return { ok: true, paramName: hit.name };
  }
  log(`✗ ${label}: setParamValue("${hit.name}") returned false — transaction reported failure, not an exception.`, "error");
  return { ok: false, paramName: hit.name };
}

/**
 * Position's real value shape (single Point control vs split X/Y sliders)
 * is unconfirmed, so this tries several encodings against a "Position"
 * param before falling back to split Position X / Position Y params, and
 * logs every attempt rather than assuming the first one worked.
 */
function trySetPosition(project, discovered, x, y, log) {
  const single = findByCandidates(discovered, ["Position"]);
  if (single) {
    const encodings = [
      { label: "array [x, y]", value: [x, y] },
      { label: "object {x, y}", value: { x, y } },
      { label: "object {horiz, vert}", value: { horiz: x, vert: y } },
    ];
    for (const encoding of encodings) {
      const attemptResult = safe(() => setParamValue(project, single.param, "raw", encoding.value));
      if (attemptResult.ok && attemptResult.value) {
        log(`✓ Position: set "Position" using encoding ${encoding.label} = ${describe(encoding.value)}`, "success");
        return { ok: true, paramName: "Position", encoding: encoding.label };
      }
      const reason = attemptResult.ok ? "returned false" : `threw: ${attemptResult.error.message || attemptResult.error}`;
      log(`  Position encoding ${encoding.label} ${reason}`, "warn");
    }
    log(`✗ Position: found "Position" param but no value encoding succeeded.`, "error");
    return { ok: false, paramName: "Position" };
  }

  const xHit = findByCandidates(discovered, ["Position X"]);
  const yHit = findByCandidates(discovered, ["Position Y"]);
  if (xHit && yHit) {
    const rx = trySetByCandidates(project, discovered, ["Position X"], "number", x, "Position X", log);
    const ry = trySetByCandidates(project, discovered, ["Position Y"], "number", y, "Position Y", log);
    return { ok: rx.ok && ry.ok, paramName: "Position X / Position Y" };
  }

  log(`✗ Position: no "Position" or "Position X"/"Position Y" param found on this .mogrt.`, "error");
  return { ok: false };
}

/**
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {string} opts.text
 * @param {number} opts.fontSize
 * @param {string} opts.fillColorHex
 * @param {number} opts.positionX
 * @param {number} opts.positionY
 * @param {number} [opts.testDurationSec]
 * @param {(message: string, level?: string) => void} opts.log
 */
export async function runSmokeTest(opts) {
  const { mogrtPath, text, fontSize, fillColorHex, positionX, positionY, testDurationSec = 3, log } = opts;

  log("════ Caption Studio host smoke test — start ════", "info");

  // 1. Active project + sequence.
  let project, sequence;
  try {
    ({ project, sequence } = await requireActiveProjectAndSequence());
    log(`✓ Active project found: "${safe(() => project.name).value ?? "(name unreadable)"}"`, "success");
    log(`✓ Active sequence found: "${safe(() => sequence.name).value ?? "(name unreadable)"}"`, "success");
  } catch (err) {
    log(`✗ No active project/sequence: ${err.message || err}`, "error");
    log("════ Smoke test aborted — nothing else can run without a sequence ════", "error");
    return { ok: false, step: "sequence" };
  }

  // 2. Target track.
  let videoTrackIndex = 0;
  const tracksResult = await safeAsync(() => listVideoTracks(sequence));
  if (tracksResult.ok && tracksResult.value.length > 0) {
    const tracks = tracksResult.value;
    log(`✓ Video tracks found: ${tracks.map((t) => `${t.name} (#${t.index})`).join(", ")}`, "success");
    videoTrackIndex = tracks[tracks.length - 1].index;
    log(`Target track resolved to index ${videoTrackIndex} (topmost existing video track).`, "info");
  } else {
    log(
      tracksResult.ok
        ? "✗ listVideoTracks() returned no tracks — is there at least one video track in this sequence?"
        : `✗ listVideoTracks() threw: ${tracksResult.error.message || tracksResult.error}`,
      "error"
    );
    log("════ Smoke test aborted — no target track to insert onto ════", "error");
    return { ok: false, step: "track" };
  }

  // 3. Start time (playhead best-effort, else selected range/sequence start).
  const rangeResult = await safeAsync(() => getSelectedRangeSeconds(sequence));
  const fallbackStartSec = rangeResult.ok ? rangeResult.value.startSec : 0;
  if (!rangeResult.ok) log(`getSelectedRangeSeconds() threw: ${rangeResult.error.message || rangeResult.error}`, "warn");
  const startSec = await resolveStartTimeSec(sequence, fallbackStartSec, log);

  // 4. MOGRT path.
  if (!mogrtPath) {
    log("✗ No test .mogrt path provided — pick one first.", "error");
    log("════ Smoke test aborted ════", "error");
    return { ok: false, step: "mogrt-path" };
  }
  log(`MOGRT path resolved: ${mogrtPath}`, "info");

  // 5. Insert.
  let trackItem;
  const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex));
  if (!insertResult.ok) {
    log(`✗ insertMogrtFromPath failed: ${insertResult.error.message || insertResult.error}`, "error");
    log("════ Smoke test aborted — insertion failed ════", "error");
    return { ok: false, step: "insert" };
  }
  trackItem = insertResult.value;
  log(`✓ Inserted MOGRT at ${startSec.toFixed(3)}s on track index ${videoTrackIndex}.`, "success");

  // 6. Trim / duration.
  const trimResult = safe(() => setTrackItemEnd(project, trackItem, startSec + testDurationSec, "Smoke test trim"));
  if (trimResult.ok && trimResult.value) {
    log(`✓ Duration: trimmed clip to ${testDurationSec}s (createSetEndAction reported success).`, "success");
  } else {
    log(
      trimResult.ok
        ? "✗ Duration: createSetEndAction reported failure (returned false)."
        : `✗ Duration: createSetEndAction threw: ${trimResult.error.message || trimResult.error}`,
      "error"
    );
  }

  // 7. Full component/param dump.
  const discovered = await dumpComponentChain(trackItem, log);

  // 8. Set the required fields, each independently logged.
  log("Setting exposed parameters…", "info");
  const results = {
    trim: trimResult.ok && trimResult.value,
    text: trySetByCandidates(project, discovered, TEXT_CANDIDATES, "string", text, "Text", log),
    fontSize: trySetByCandidates(project, discovered, FONT_SIZE_CANDIDATES, "number", fontSize, "Font size", log),
    fillColor: trySetByCandidates(project, discovered, FILL_COLOR_CANDIDATES, "color", fillColorHex, "Fill colour", log),
    position: trySetPosition(project, discovered, positionX, positionY, log),
  };

  const bgHit = findByCandidates(discovered, BG_OPACITY_CANDIDATES);
  if (bgHit) {
    results.backgroundOpacity = trySetByCandidates(project, discovered, BG_OPACITY_CANDIDATES, "percent", 60, "Background opacity", log);
  } else {
    log(`… Background opacity: no matching param found on this .mogrt — skipping (marked optional).`, "warn");
    results.backgroundOpacity = { ok: false, skipped: true };
  }

  const summary = {
    sequence: true,
    track: true,
    insert: true,
    trim: results.trim,
    text: results.text.ok,
    fontSize: results.fontSize.ok,
    fillColor: results.fillColor.ok,
    position: results.position.ok,
    backgroundOpacity: results.backgroundOpacity.ok || results.backgroundOpacity.skipped,
  };
  const passCount = Object.values(results).filter((r) => r === true || r?.ok).length;
  log(`Summary: ${describe(summary)}`, "info");
  log(`════ Caption Studio host smoke test — finished (${passCount}/5 param checks passed) ════`, passCount === 5 ? "success" : "warn");

  return { ok: true, trackItem, discovered, results };
}
