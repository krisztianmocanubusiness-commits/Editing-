import { insertMogrtAt, setTrackItemEnd, findExposedParams } from "./mogrt.js";
import { setParamValue, setPointParamValue, keyframeParam } from "./componentParams.js";
import { flattenPresetForMogrt, resolveParamName } from "../presets/mogrtContract.js";

/**
 * @typedef {Object} ApplyResult
 * @property {import("../caption/types.js").CaptionChunk} chunk
 * @property {boolean} ok
 * @property {string} [error]
 * @property {string[]} [missingParams]  Exposed params the preset wanted but the .mogrt didn't have.
 */

/**
 * Apply one caption chunk to the timeline: insert the preset's .mogrt at the
 * chunk's start time, trim it to the chunk's duration, and push every style
 * field the preset defines into whatever exposed params the template
 * actually has (skipping + reporting the rest rather than throwing, since
 * different templates will legitimately expose different subsets).
 *
 * @param {import("@adobe/premierepro").Project} project
 * @param {import("@adobe/premierepro").Sequence} sequence
 * @param {import("../caption/types.js").CaptionChunk} chunk
 * @param {import("../presets/types.js").Preset} preset
 * @param {number} videoTrackIndex
 * @returns {Promise<ApplyResult>}
 */
export async function applyChunkToTimeline(project, sequence, chunk, preset, videoTrackIndex) {
  if (!preset.mogrt?.path) {
    return { chunk, ok: false, error: "Preset has no .mogrt path configured." };
  }

  let trackItem;
  try {
    trackItem = await insertMogrtAt(project, sequence, preset.mogrt.path, chunk.startSec, videoTrackIndex);
  } catch (err) {
    return { chunk, ok: false, error: `Insert failed: ${err.message || err}` };
  }

  setTrackItemEnd(project, trackItem, chunk.endSec, `Trim caption "${chunk.text.slice(0, 24)}"`);

  const instructions = flattenPresetForMogrt(preset, chunk);
  const paramNames = instructions.map((i) => i.paramName);
  const { found, missing } = await findExposedParams(trackItem, paramNames);

  for (const instr of instructions) {
    const param = found.get(instr.paramName);
    if (!param) continue;
    if (instr.kind === "point") {
      // Combined Position control (e.g. KERIS_CAPTION_V1_PPRO) — see
      // flattenPresetForMogrt() in mogrtContract.js and
      // setPointParamValue()'s doc comment for why this needs to try
      // multiple value shapes instead of a single coerceValue() kind.
      setPointParamValue(project, param, instr.value.x, instr.value.y);
    } else {
      setParamValue(project, param, instr.kind, instr.value);
    }
  }

  // Graceful degrade: if this .mogrt doesn't implement the baked-in
  // "Animation Style" selector, synthesize a basic fade in/out on
  // Fill Opacity so entrance/exit still does *something* instead of the
  // caption just hard-cutting in and out.
  const hasBakedAnimation = found.has(resolveParamName(preset, "animationStyleIndex"));
  const opacityParam = found.get(resolveParamName(preset, "fillOpacity"));
  if (!hasBakedAnimation && opacityParam && (preset.animation.entrance.style !== "none" || preset.animation.exit.style !== "none")) {
    const duration = chunk.endSec - chunk.startSec;
    const inMs = preset.animation.entrance.durationMs / 1000;
    const outMs = preset.animation.exit.durationMs / 1000;
    const targetOpacity = preset.color.opacity;
    keyframeParam(project, opacityParam, [
      { atSec: 0, value: preset.animation.entrance.style === "none" ? targetOpacity : 0, kind: "percent" },
      { atSec: Math.min(inMs, duration / 2), value: targetOpacity, kind: "percent" },
      { atSec: Math.max(duration - outMs, duration / 2), value: targetOpacity, kind: "percent" },
      { atSec: duration, value: preset.animation.exit.style === "none" ? targetOpacity : 0, kind: "percent" },
    ]);
  }

  return { chunk, ok: true, missingParams: missing, trackItem };
}

/**
 * Apply every approved caption chunk to the timeline, one mogrt instance
 * each, stopping on nothing (best-effort per-chunk so one bad chunk doesn't
 * abort the whole batch) and returning a per-chunk result log for the UI.
 *
 * @param {import("@adobe/premierepro").Project} project
 * @param {import("@adobe/premierepro").Sequence} sequence
 * @param {import("../caption/types.js").CaptionChunk[]} chunks
 * @param {import("../presets/types.js").Preset} preset
 * @param {number} videoTrackIndex
 * @returns {Promise<ApplyResult[]>}
 */
export async function applyCaptionsToTimeline(project, sequence, chunks, preset, videoTrackIndex) {
  const results = [];
  for (const chunk of chunks) {
    // eslint-disable-next-line no-await-in-loop
    const result = await applyChunkToTimeline(project, sequence, chunk, preset, videoTrackIndex);
    results.push(result);
  }
  return results;
}
