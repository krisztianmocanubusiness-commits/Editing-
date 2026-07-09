import { getPpro } from "./client.js";
import { secToTick } from "./time.js";

/**
 * Convert a hex color string to the plain-object shape most Premiere/AE
 * color controls accept over scripting (0-255 channels + alpha).
 * UNCONFIRMED against a live host — see setParamValue()'s color branch.
 */
export function hexToColorObject(hex) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  return {
    red: (num >> 16) & 255,
    green: (num >> 8) & 255,
    blue: num & 255,
    alpha: 255,
  };
}

export function coerceValue(kind, value) {
  switch (kind) {
    case "bool":
      return value ? 1 : 0;
    case "number":
    case "percent":
      return Number(value);
    case "color":
      return hexToColorObject(value);
    case "string":
    default:
      return value;
  }
}

/**
 * Set a single exposed ComponentParam's value at the current time, following
 * the `createKeyframe(value)` + `createSetValueAction(keyframe, true)`
 * pattern confirmed in Adobe's sample (keyframe.ts `setValue`).
 *
 * IMPORTANT / UNCONFIRMED: that sample only exercises a numeric param. This
 * project also uses the same call shape for "color" (object) and "string"
 * (Source Text) params, which Adobe's public sample does not demonstrate.
 * If your installed Premiere/UXP version rejects a color object or string
 * here, the fix is isolated to this function — e.g. some hosts may need
 * `param.setValue(value)` directly instead of the keyframe indirection.
 *
 * @param {import("@adobe/premierepro").Project} project
 * @param {import("@adobe/premierepro").ComponentParam} param
 * @param {"string"|"number"|"percent"|"color"|"bool"} kind
 * @param {*} value
 */
export function setParamValue(project, param, kind, value) {
  const coerced = coerceValue(kind, value);
  let success = false;
  try {
    project.lockedAccess(() => {
      success = project.executeTransaction((compoundAction) => {
        const keyframe = param.createKeyframe(coerced);
        compoundAction.addAction(param.createSetValueAction(keyframe, true));
      }, `Set ${param.displayName ?? "param"}`);
    });
  } catch (err) {
    // Re-throw with the param name attached so callers logging the error
    // (see src/ppro/smokeTest.js) don't have to guess which param blew up.
    throw new Error(`setParamValue(${param.displayName ?? "param"}, ${kind}) failed: ${err.message || err}`);
  }
  return success;
}

/**
 * Add entrance/exit keyframes to a param over the lifetime of one caption
 * chunk, using the time-varying + add-keyframe + interpolation pattern
 * confirmed in Adobe's sample (keyframe.ts `addKeyframe`/`setInterpolation`).
 *
 * @param {import("@adobe/premierepro").Project} project
 * @param {import("@adobe/premierepro").ComponentParam} param
 * @param {{ atSec: number, value: * , kind?: "number"|"percent" }[]} keyframes
 *        Times are chunk-relative seconds (0 = chunk start).
 */
export function keyframeParam(project, param, keyframes) {
  let success = false;
  const ppro = getPpro();
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(param.createSetTimeVaryingAction(true));
    }, `Enable keyframing on ${param.displayName ?? "param"}`);
  });
  if (!success) return false;

  for (const kf of keyframes) {
    const kind = kf.kind || "number";
    const coerced = coerceValue(kind, kf.value);
    project.lockedAccess(() => {
      const ok = project.executeTransaction((compoundAction) => {
        const keyframe = param.createKeyframe(coerced);
        keyframe.position = secToTick(kf.atSec);
        compoundAction.addAction(param.createAddKeyframeAction(keyframe));
      }, `Keyframe ${param.displayName ?? "param"} @ ${kf.atSec.toFixed(2)}s`);
      success = success && ok;
    });

    project.lockedAccess(() => {
      const ok = project.executeTransaction((compoundAction) => {
        compoundAction.addAction(
          param.createSetInterpolationAtKeyframeAction(
            secToTick(kf.atSec),
            ppro.Constants.InterpolationMode.BEZIER
          )
        );
      }, `Ease ${param.displayName ?? "param"} @ ${kf.atSec.toFixed(2)}s`);
      success = success && ok;
    });
  }

  return success;
}
