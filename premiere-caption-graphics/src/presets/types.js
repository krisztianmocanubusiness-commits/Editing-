/**
 * @typedef {Object} GradientStop
 * @property {string} color     hex, e.g. "#FF6B00"
 * @property {number} position  0-100
 *
 * @typedef {Object} Preset
 * @property {string} id
 * @property {string} name
 * @property {Object} font
 * @property {string} font.family
 * @property {number} font.size        px at 1080-height reference frame
 * @property {number} font.weight      100-900
 * @property {boolean} font.italic
 * @property {Object} color
 * @property {string} color.fill       hex
 * @property {number} color.opacity    0-100
 * @property {Object} gradient
 * @property {boolean} gradient.enabled
 * @property {number} gradient.angleDeg
 * @property {GradientStop[]} gradient.stops
 * @property {Object} backgroundBox
 * @property {boolean} backgroundBox.enabled
 * @property {string} backgroundBox.color
 * @property {number} backgroundBox.opacity     0-100
 * @property {number} backgroundBox.cornerRadius px
 * @property {number} backgroundBox.paddingX    px
 * @property {number} backgroundBox.paddingY    px
 * @property {Object} position
 * @property {"top"|"center"|"bottom"} position.vertical
 * @property {"left"|"center"|"right"} position.horizontal
 * @property {number} position.offsetX   px, relative to anchor
 * @property {number} position.offsetY   px, relative to anchor
 * @property {number} position.safeMarginPct  0-100, keep-out margin from frame edge
 * @property {number} tracking           letter-spacing, em/1000 units (Premiere "Tracking" scale)
 * @property {Object} shadow
 * @property {boolean} shadow.enabled
 * @property {string} shadow.color
 * @property {number} shadow.opacity     0-100
 * @property {number} shadow.angleDeg
 * @property {number} shadow.distance    px
 * @property {number} shadow.softness    px
 * @property {Object} blur
 * @property {boolean} blur.enabled
 * @property {number} blur.amount        px
 * @property {Object} animation
 * @property {Object} animation.entrance
 * @property {"none"|"fade"|"pop"|"slide-up"|"slide-down"|"typewriter"} animation.entrance.style
 * @property {number} animation.entrance.durationMs
 * @property {Object} animation.exit
 * @property {"none"|"fade"|"pop"|"slide-up"|"slide-down"} animation.exit.style
 * @property {number} animation.exit.durationMs
 * @property {Object} emphasis
 * @property {boolean} emphasis.enabled
 * @property {"auto-keywords"|"manual"} emphasis.mode
 * @property {string} emphasis.color
 * @property {number} emphasis.scale        1.0 = no change
 * @property {number} emphasis.weightBoost  added to font.weight, clamped to 900
 * @property {Object} mogrt
 * @property {string} mogrt.path            Local filesystem path to the .mogrt this preset drives.
 * @property {string|null} mogrt.contractId Id of a named contract in src/presets/contracts (e.g. "KERIS_CAPTION_V1")
 *   whose paramMap supplies the default preset-field -> exposed-param-name mapping. See mogrtContract.js resolveParamName().
 * @property {Object.<string,string>} mogrt.paramMap  Per-preset overrides, highest priority: preset-field-key -> Essential Graphics exposed param display name
 */

/** @returns {Preset} */
export function createDefaultPreset(name = "Untitled Preset", id) {
  return {
    id: id || name.toLowerCase().replace(/\s+/g, "-"),
    name,
    font: { family: "Helvetica Neue", size: 72, weight: 700, italic: false },
    color: { fill: "#FFFFFF", opacity: 100 },
    gradient: {
      enabled: false,
      angleDeg: 90,
      stops: [
        { color: "#FFFFFF", position: 0 },
        { color: "#CCCCCC", position: 100 },
      ],
    },
    backgroundBox: {
      enabled: false,
      color: "#000000",
      opacity: 60,
      cornerRadius: 12,
      paddingX: 24,
      paddingY: 12,
    },
    position: {
      vertical: "bottom",
      horizontal: "center",
      offsetX: 0,
      offsetY: -180,
      safeMarginPct: 8,
    },
    tracking: 0,
    shadow: {
      enabled: true,
      color: "#000000",
      opacity: 75,
      angleDeg: 135,
      distance: 6,
      softness: 10,
    },
    blur: { enabled: false, amount: 0 },
    animation: {
      entrance: { style: "pop", durationMs: 180 },
      exit: { style: "fade", durationMs: 120 },
    },
    emphasis: {
      enabled: true,
      mode: "auto-keywords",
      color: "#FFD400",
      scale: 1.12,
      weightBoost: 100,
    },
    mogrt: { path: "", contractId: null, paramMap: {} },
  };
}

/** Deep-clone a preset so editing one instance never mutates the library default. */
export function clonePreset(preset) {
  return JSON.parse(JSON.stringify(preset));
}
