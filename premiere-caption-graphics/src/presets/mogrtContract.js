import { getContract } from "./contracts/index.js";

/**
 * The "authoring contract" between this extension and the .mogrt files it
 * drives.
 *
 * Premiere's UXP scripting API can insert a Motion Graphics Template and
 * read/write whichever of its properties the *template author* checked
 * "Expose" on in the Essential Graphics panel (see Component/ComponentParam
 * in ../ppro/mogrt.js). It cannot fabricate new text layers, effects, or
 * animation rigs from scratch. So every style dimension the preset UI
 * exposes must correspond to a named, exposed control on the underlying
 * .mogrt, authored once in After Effects/Premiere by a motion designer.
 *
 * A preset field's exposed-param name is resolved with three tiers of
 * priority (see resolveParamName()):
 *   1. `preset.mogrt.paramMap[fieldKey]`      — explicit per-preset override
 *   2. the named contract's `paramMap[fieldKey]` — `preset.mogrt.contractId`,
 *      e.g. "KERIS_CAPTION_V1" (see ./contracts/kerisCaptionV1.js and
 *      /mogrt-contracts/KERIS_CAPTION_V1.md)
 *   3. CANONICAL_PARAMS[fieldKey]              — generic fallback default
 *
 * CANONICAL_PARAMS below is that generic fallback, covering every style
 * dimension the preset UI exposes (including a few, like gradient and
 * per-word emphasis, that no shipped contract requires yet — see
 * mogrt-authoring/README.md for the full, unconstrained spec vs. a named
 * contract like KERIS_CAPTION_V1's smaller required set).
 */
export const CANONICAL_PARAMS = {
  captionText: "Caption Text",
  emphasisText: "Emphasis Word",

  fontSize: "Font Size",
  fontWeight: "Font Weight",
  fillColor: "Fill Color",
  fillOpacity: "Fill Opacity",

  gradientEnabled: "Gradient Enabled",
  gradientStartColor: "Gradient Start Color",
  gradientEndColor: "Gradient End Color",
  gradientAngle: "Gradient Angle",

  bgBoxEnabled: "Background Enabled",
  bgBoxColor: "Background Color",
  bgBoxOpacity: "Background Opacity",
  bgBoxCornerRadius: "Background Corner Radius",
  bgBoxPaddingX: "Background Padding X",
  bgBoxPaddingY: "Background Padding Y",

  positionX: "Position X",
  positionY: "Position Y",
  tracking: "Tracking",

  shadowEnabled: "Shadow Enabled",
  shadowColor: "Shadow Color",
  shadowOpacity: "Shadow Opacity",
  shadowAngle: "Shadow Angle",
  shadowDistance: "Shadow Distance",
  shadowSoftness: "Shadow Softness",

  blurEnabled: "Blur Enabled",
  blurAmount: "Blur Amount",

  animationStyleIndex: "Animation Style",
  entranceDurationMs: "Entrance Duration",
  exitDurationMs: "Exit Duration",

  emphasisEnabled: "Emphasis Enabled",
  emphasisColor: "Emphasis Color",
  emphasisScale: "Emphasis Scale",
};

// Order matters only for readability/log output; the animation style names a
// template must implement as discrete looks (baked in AE), selected by index.
export const ANIMATION_STYLES = ["none", "fade", "pop", "slide-up", "slide-down", "typewriter"];

export function resolveParamName(preset, fieldKey) {
  const override = preset.mogrt?.paramMap?.[fieldKey];
  if (override) return override;

  const contract = preset.mogrt?.contractId ? getContract(preset.mogrt.contractId) : null;
  const fromContract = contract?.paramMap?.[fieldKey];
  if (fromContract) return fromContract;

  return CANONICAL_PARAMS[fieldKey];
}

function animationIndex(style) {
  const i = ANIMATION_STYLES.indexOf(style);
  return i === -1 ? 0 : i;
}

/**
 * Flatten a Preset (+ the caption chunk it's being applied to) into an
 * ordered list of { fieldKey, paramName, kind, value } instructions for the
 * Premiere application layer to push onto the mogrt's exposed parameters.
 *
 * `kind` tells ppro/componentParams.js how to coerce the value:
 *   "string" | "number" | "percent" | "color" | "bool"
 *
 * @param {import("./types.js").Preset} preset
 * @param {import("../caption/types.js").CaptionChunk} chunk
 */
export function flattenPresetForMogrt(preset, chunk) {
  const out = [];
  const put = (fieldKey, kind, value) =>
    out.push({ fieldKey, paramName: resolveParamName(preset, fieldKey), kind, value });

  put("captionText", "string", chunk.text);
  if (preset.emphasis.enabled && chunk.emphasisOn && chunk.keywords.length > 0) {
    put("emphasisText", "string", chunk.keywords.join(", "));
    put("emphasisEnabled", "bool", true);
    put("emphasisColor", "color", preset.emphasis.color);
    put("emphasisScale", "number", preset.emphasis.scale);
  } else {
    put("emphasisEnabled", "bool", false);
  }

  put("fontSize", "number", preset.font.size);
  put("fontWeight", "number", preset.font.weight);
  put("fillColor", "color", preset.color.fill);
  put("fillOpacity", "percent", preset.color.opacity);

  put("gradientEnabled", "bool", preset.gradient.enabled);
  if (preset.gradient.enabled) {
    put("gradientStartColor", "color", preset.gradient.stops[0]?.color ?? "#FFFFFF");
    put("gradientEndColor", "color", preset.gradient.stops[preset.gradient.stops.length - 1]?.color ?? "#FFFFFF");
    put("gradientAngle", "number", preset.gradient.angleDeg);
  }

  put("bgBoxEnabled", "bool", preset.backgroundBox.enabled);
  if (preset.backgroundBox.enabled) {
    put("bgBoxColor", "color", preset.backgroundBox.color);
    put("bgBoxOpacity", "percent", preset.backgroundBox.opacity);
    put("bgBoxCornerRadius", "number", preset.backgroundBox.cornerRadius);
    put("bgBoxPaddingX", "number", preset.backgroundBox.paddingX);
    put("bgBoxPaddingY", "number", preset.backgroundBox.paddingY);
  }

  put("positionX", "number", preset.position.offsetX);
  put("positionY", "number", preset.position.offsetY);
  put("tracking", "number", preset.tracking);

  put("shadowEnabled", "bool", preset.shadow.enabled);
  if (preset.shadow.enabled) {
    put("shadowColor", "color", preset.shadow.color);
    put("shadowOpacity", "percent", preset.shadow.opacity);
    put("shadowAngle", "number", preset.shadow.angleDeg);
    put("shadowDistance", "number", preset.shadow.distance);
    put("shadowSoftness", "number", preset.shadow.softness);
  }

  put("blurEnabled", "bool", preset.blur.enabled);
  if (preset.blur.enabled) {
    put("blurAmount", "number", preset.blur.amount);
  }

  put("animationStyleIndex", "number", animationIndex(preset.animation.entrance.style));
  put("entranceDurationMs", "number", preset.animation.entrance.durationMs);
  put("exitDurationMs", "number", preset.animation.exit.durationMs);

  return out;
}
