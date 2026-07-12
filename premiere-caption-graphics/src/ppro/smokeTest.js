/**
 * Host validation pass for the Premiere scripting layer, checked by default
 * against KERIS_CAPTION_V1_PPRO — the recommended contract for
 * Premiere-authored MOGRTs (see
 * /mogrt-authoring/PREMIERE_ONLY_GUIDE.md and
 * ../presets/contracts/kerisCaptionV1Ppro.js). Pass `opts.contract` to
 * check against KERIS_CAPTION_V1 instead for an After-Effects-authored
 * template that implements the fuller contract (split Position X/Y, a
 * baked Entrance Style rig).
 *
 * This deliberately avoids the preset/apply pipeline (only the component-
 * discovery walk is shared, via ./introspect.js): the point of this module
 * is to be a *minimal, isolated* path from "click a button" to
 * "one styled MOGRT on the timeline" with maximum logging at every step, so
 * a human watching the UDT console can see exactly which Premiere UXP API
 * calls actually work on their installed host and which don't. Nothing
 * here is allowed to silently assume success — every call is wrapped and
 * its real return value / thrown error is logged.
 *
 * Two independent checks come out of this, and they answer different
 * questions:
 *   - the per-field "trySetByCandidates" writes are best-effort — they try
 *     the target contract's exact param name plus a couple of legacy
 *     aliases (including the *other* contract's names), so this still
 *     reports something useful against a template built for either
 *     contract, or no contract at all.
 *   - the "contract compliance" check (step 8) is strict — it compares the
 *     template's real discovered param names against the target
 *     contract's required list with no aliasing, so it can tell an editor
 *     *exactly* which named control is missing.
 *
 * Only fields the target contract actually requires count toward the
 * PASS/PARTIAL core-check summary — e.g. Entrance Style is never required
 * against the default KERIS_CAPTION_V1_PPRO target, so a Premiere-only
 * template that doesn't have it can still show PASS.
 */
import { requireActiveProjectAndSequence, resolveInsertionTimeSec, listVideoTracks } from "./timelineRange.js";
import { insertMogrtAt, setTrackItemEnd } from "./mogrt.js";
import { setParamValue, coerceValue, POINT_VALUE_ENCODINGS } from "./componentParams.js";
import { KERIS_CAPTION_V1_PPRO, KERIS_CAPTION_V1 } from "../presets/contracts/index.js";
import { validateAgainstContract, describeCompliance, describeCompatibilityLabel } from "../presets/contractValidation.js";
import { safe, safeAsync, describeValue as describe, dumpComponentChain } from "./introspect.js";

const P = KERIS_CAPTION_V1_PPRO.paramMap;
const P_AE = KERIS_CAPTION_V1.paramMap;

// Target contract's name first (exact match this template is expected to
// have), then legacy aliases — including the *other* contract's name where
// relevant — kept only so this test still says something useful against a
// template built for the other contract, or no contract at all.
const TEXT_CANDIDATES = [P.captionText, "Caption Text", "Source Text"];
const FONT_SIZE_CANDIDATES = [P.fontSize, "Size"];
const FILL_COLOR_CANDIDATES = [P.fillColor, "Fill Colour", "Color", "Colour"];
const FILL_OPACITY_CANDIDATES = [P.fillOpacity, "Fill Opacity"];
const BG_OPACITY_CANDIDATES = [P.bgBoxOpacity, "Background Enabled", "Opacity"];
const BG_COLOR_CANDIDATES = [P.bgBoxColor, "Background Colour"];
const TRACKING_CANDIDATES = [P.tracking, "Letter Spacing"];
const SHADOW_OPACITY_CANDIDATES = [P.shadowOpacity, "Drop Shadow Opacity"];
// Entrance Style only exists on the fuller (After Effects) contract — this
// is a best-effort check even against the Premiere-only default target.
const ENTRANCE_STYLE_CANDIDATES = [P_AE.animationStyleIndex, "Animation Style"];

function findByCandidates(discovered, candidateNames) {
  for (const name of candidateNames) {
    if (!name) continue;
    const hit = discovered.find((d) => d.name === name);
    if (hit) return hit;
  }
  return null;
}

/** Set one param by trying a list of plausible display names, logging exactly what happened. */
function trySetByCandidates(project, discovered, candidateNames, kind, value, label, log) {
  const hit = findByCandidates(discovered, candidateNames);
  if (!hit) {
    log(`✗ ${label}: no param matched (tried: ${candidateNames.filter(Boolean).join(", ")})`, "error");
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
 * KERIS_CAPTION_V1_PPRO (the default target) requires one combined
 * "Position" point control, so that's tried first, using the shared
 * POINT_VALUE_ENCODINGS list (see componentParams.js) since its real value
 * shape is otherwise unconfirmed — every encoding attempt is logged rather
 * than assuming the first one worked. Split "Position X"/"Position Y"
 * (KERIS_CAPTION_V1, After Effects-authored templates) is tried as a
 * fallback for templates built against the fuller contract.
 */
function trySetPosition(project, discovered, x, y, log) {
  const single = findByCandidates(discovered, [P.positionX, "Position"]);
  if (single) {
    for (const encoding of POINT_VALUE_ENCODINGS) {
      const value = encoding.toValue(x, y);
      const attemptResult = safe(() => setParamValue(project, single.param, "raw", value));
      if (attemptResult.ok && attemptResult.value) {
        log(`✓ Position: set "${single.name}" using encoding ${encoding.label} = ${describe(value)}`, "success");
        return { ok: true, paramName: single.name, encoding: encoding.label };
      }
      const reason = attemptResult.ok ? "returned false" : `threw: ${attemptResult.error.message || attemptResult.error}`;
      log(`  Position encoding ${encoding.label} ${reason}`, "warn");
    }
    log(`✗ Position: found "${single.name}" param but no value encoding succeeded.`, "error");
    return { ok: false, paramName: single.name };
  }

  const xHit = findByCandidates(discovered, [P_AE.positionX, "Position X"]);
  const yHit = findByCandidates(discovered, [P_AE.positionY, "Position Y"]);
  if (xHit && yHit) {
    const rx = trySetByCandidates(project, discovered, [xHit.name], "number", x, "Position X", log);
    const ry = trySetByCandidates(project, discovered, [yHit.name], "number", y, "Position Y", log);
    return { ok: rx.ok && ry.ok, paramName: "Position X / Position Y" };
  }

  log(`✗ Position: no "${P.positionX}" or "Position X"/"Position Y" param found on this .mogrt.`, "error");
  return { ok: false };
}

// Maps each field this test checks to the preset-field-key its contract
// paramMap would use, so "is this field required by the target contract"
// can be derived generically instead of hardcoded per contract. See
// isFieldRequired() below.
const FIELD_TO_MAP_KEY = {
  text: "captionText",
  fontSize: "fontSize",
  fillColor: "fillColor",
  position: "positionX", // proxy: tracks whichever position scheme (split or combined) the contract requires
  tracking: "tracking",
  entranceStyle: "animationStyleIndex",
  backgroundOpacity: "bgBoxOpacity",
  backgroundColor: "bgBoxColor",
  shadowOpacity: "shadowOpacity",
  fillOpacity: "fillOpacity",
};

function isFieldRequired(contract, field) {
  const name = contract.paramMap?.[FIELD_TO_MAP_KEY[field]];
  return Boolean(name) && contract.requiredParams.includes(name);
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
 * @param {{ id: string, requiredParams: string[], paramMap: object }} [opts.contract] Defaults to KERIS_CAPTION_V1_PPRO.
 */
export async function runSmokeTest(opts) {
  const { mogrtPath, text, fontSize, fillColorHex, positionX, positionY, testDurationSec = 3, log, contract = KERIS_CAPTION_V1_PPRO } = opts;

  log(
    `════ Caption Studio host smoke test — start (contract: ${contract.id}, ${describeCompatibilityLabel(contract)}) ════`,
    "info"
  );

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

  // 3. Start time (playhead best-effort, else selected range/sequence start, else 0 — see resolveInsertionTimeSec()).
  const startSec = await resolveInsertionTimeSec(sequence, log);

  // 4. MOGRT path.
  if (!mogrtPath) {
    log("✗ No test .mogrt path provided — pick one first.", "error");
    log("════ Smoke test aborted ════", "error");
    return { ok: false, step: "mogrt-path" };
  }
  log(`MOGRT path resolved: ${mogrtPath}`, "info");

  // 5. Insert.
  let trackItem;
  const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log));
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

  // 8. Strict contract compliance — exact required-name match, no aliasing.
  // This is the check that tells the editor precisely which named control
  // is missing on this .mogrt, independent of whether a fallback alias
  // happened to let the best-effort writes below succeed anyway.
  const discoveredNames = discovered.map((d) => d.name);
  const compliance = validateAgainstContract(discoveredNames, contract);
  log(describeCompliance(compliance), compliance.isCompliant ? "success" : "error");

  // 9. Best-effort writes for every field this test knows how to check,
  // each logged. Only the ones the target contract actually requires (see
  // isFieldRequired()) count toward the PASS/PARTIAL summary below.
  log("Setting exposed parameters…", "info");
  const results = {
    trim: trimResult.ok && trimResult.value,
    text: trySetByCandidates(project, discovered, TEXT_CANDIDATES, "string", text, "Text", log),
    fontSize: trySetByCandidates(project, discovered, FONT_SIZE_CANDIDATES, "number", fontSize, "Font size", log),
    fillColor: trySetByCandidates(project, discovered, FILL_COLOR_CANDIDATES, "color", fillColorHex, "Fill colour", log),
    position: trySetPosition(project, discovered, positionX, positionY, log),
    tracking: trySetByCandidates(project, discovered, TRACKING_CANDIDATES, "number", 0, "Tracking", log),
    entranceStyle: trySetByCandidates(project, discovered, ENTRANCE_STYLE_CANDIDATES, "number", 1, "Entrance style", log),
  };

  const fillOpacityHit = findByCandidates(discovered, FILL_OPACITY_CANDIDATES);
  results.fillOpacity = fillOpacityHit
    ? trySetByCandidates(project, discovered, FILL_OPACITY_CANDIDATES, "percent", 100, "Fill opacity", log)
    : (log("… Fill opacity: no matching param found on this .mogrt — skipping (recommended, not required).", "warn"), { ok: false, skipped: true });

  const bgOpacityHit = findByCandidates(discovered, BG_OPACITY_CANDIDATES);
  results.backgroundOpacity = bgOpacityHit
    ? trySetByCandidates(project, discovered, BG_OPACITY_CANDIDATES, "percent", 60, "Background opacity", log)
    : (log("… Background opacity: no matching param found on this .mogrt — skipping.", "warn"), { ok: false, skipped: true });

  const bgColorHit = findByCandidates(discovered, BG_COLOR_CANDIDATES);
  results.backgroundColor = bgColorHit
    ? trySetByCandidates(project, discovered, BG_COLOR_CANDIDATES, "color", "#E8D9BE", "Background colour", log)
    : (log("… Background colour: no matching param found on this .mogrt — skipping.", "warn"), { ok: false, skipped: true });

  const shadowHit = findByCandidates(discovered, SHADOW_OPACITY_CANDIDATES);
  results.shadowOpacity = shadowHit
    ? trySetByCandidates(project, discovered, SHADOW_OPACITY_CANDIDATES, "percent", 75, "Shadow opacity", log)
    : (log("… Shadow opacity: no matching param found on this .mogrt — skipping.", "warn"), { ok: false, skipped: true });

  const coreFields = Object.keys(results).filter((field) => field !== "trim" && isFieldRequired(contract, field));
  const coreChecks = coreFields.map((field) => results[field]);
  const passCount = coreChecks.filter((r) => r.ok).length;

  const summary = {
    contract: contract.id,
    compatibility: contract.compatibility,
    contractCompliant: compliance.isCompliant,
    missingRequired: compliance.missingRequired,
    trim: results.trim,
    coreFieldsChecked: coreFields,
    text: results.text.ok,
    fontSize: results.fontSize.ok,
    fillColor: results.fillColor.ok,
    fillOpacity: results.fillOpacity.ok || results.fillOpacity.skipped,
    position: results.position.ok,
    tracking: results.tracking.ok,
    entranceStyle: results.entranceStyle.ok,
    backgroundOpacity: results.backgroundOpacity.ok || results.backgroundOpacity.skipped,
    backgroundColor: results.backgroundColor.ok || results.backgroundColor.skipped,
    shadowOpacity: results.shadowOpacity.ok || results.shadowOpacity.skipped,
  };
  log(`Summary: ${describe(summary)}`, "info");
  log(
    `════ Caption Studio host smoke test — finished (${passCount}/${coreChecks.length} core param checks passed for ` +
      `${contract.id}, contract ${compliance.isCompliant ? "COMPLIANT" : "NOT COMPLIANT"}) ════`,
    passCount === coreChecks.length && compliance.isCompliant ? "success" : "warn"
  );

  return {
    ok: true,
    trackItem,
    discovered,
    results,
    compliance,
    coreFields,
    // Precomputed so callers (see src/ui/smokeTestPanel.js) don't need to
    // re-derive "which fields are core for this contract" themselves.
    allCorePassed: coreChecks.length > 0 && passCount === coreChecks.length,
  };
}
