import { clonePreset } from "./types.js";

/**
 * Returns a preset clone whose `mogrt.path`/`mogrt.contractId` fall back to
 * the saved "active template" (see src/state/settings.js,
 * src/ui/templateInspectorPanel.js) when the preset itself doesn't specify
 * one. An explicit preset-level `mogrt.path` always wins — this is a
 * default, not an override — so a preset that already points at its own
 * template (e.g. via presetPanel.js's "Choose .mogrt…") keeps working
 * exactly as before.
 *
 * @param {import("./types.js").Preset} preset
 * @param {{ path: string, contractId: string|null }|null} activeTemplate
 * @returns {import("./types.js").Preset}
 */
export function withActiveTemplateFallback(preset, activeTemplate) {
  if (preset.mogrt?.path) return preset;
  if (!activeTemplate?.path) return preset;

  const effective = clonePreset(preset);
  effective.mogrt.path = activeTemplate.path;
  effective.mogrt.contractId = effective.mogrt.contractId || activeTemplate.contractId || null;
  return effective;
}
