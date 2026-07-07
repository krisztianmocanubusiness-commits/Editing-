import { createDefaultPreset } from "./types.js";

function preset(name, overrides) {
  const base = createDefaultPreset(name);
  return deepMerge(base, overrides);
}

function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    const sVal = source[key];
    if (sVal && typeof sVal === "object" && !Array.isArray(sVal)) {
      target[key] = deepMerge(target[key] ? { ...target[key] } : {}, sVal);
    } else {
      target[key] = sVal;
    }
  }
  return target;
}

export const BUILT_IN_PRESETS = [
  preset("Bold Pop", {
    font: { family: "Helvetica Neue", size: 84, weight: 800 },
    color: { fill: "#FFFFFF" },
    backgroundBox: { enabled: false },
    shadow: { enabled: true, distance: 8, softness: 14 },
    animation: {
      entrance: { style: "pop", durationMs: 160 },
      exit: { style: "fade", durationMs: 100 },
    },
    emphasis: { enabled: true, mode: "auto-keywords", color: "#FFD400", scale: 1.18 },
  }),

  preset("Neon Gradient", {
    font: { family: "Poppins", size: 78, weight: 700 },
    color: { fill: "#FFFFFF" },
    gradient: {
      enabled: true,
      angleDeg: 90,
      stops: [
        { color: "#00F5FF", position: 0 },
        { color: "#FF00E5", position: 100 },
      ],
    },
    blur: { enabled: false },
    shadow: { enabled: true, color: "#00F5FF", opacity: 55, distance: 0, softness: 24 },
    animation: {
      entrance: { style: "slide-up", durationMs: 220 },
      exit: { style: "slide-up", durationMs: 160 },
    },
    emphasis: { enabled: true, mode: "auto-keywords", color: "#FF00E5", scale: 1.15 },
  }),

  preset("Minimal Clean", {
    font: { family: "Inter", size: 60, weight: 500 },
    color: { fill: "#FFFFFF" },
    backgroundBox: {
      enabled: true,
      color: "#000000",
      opacity: 55,
      cornerRadius: 10,
      paddingX: 20,
      paddingY: 10,
    },
    tracking: 10,
    shadow: { enabled: false },
    animation: {
      entrance: { style: "fade", durationMs: 140 },
      exit: { style: "fade", durationMs: 140 },
    },
    emphasis: { enabled: true, mode: "auto-keywords", color: "#FFFFFF", weightBoost: 200, scale: 1.0 },
  }),

  preset("Karaoke Line", {
    font: { family: "Helvetica Neue", size: 72, weight: 700 },
    color: { fill: "#E6E6E6" },
    backgroundBox: { enabled: false },
    shadow: { enabled: true, distance: 5, softness: 8 },
    animation: {
      entrance: { style: "typewriter", durationMs: 260 },
      exit: { style: "fade", durationMs: 100 },
    },
    emphasis: { enabled: true, mode: "auto-keywords", color: "#39FF14", scale: 1.1, weightBoost: 100 },
  }),
];

export function getPresetById(id) {
  return BUILT_IN_PRESETS.find((p) => p.id === id);
}
