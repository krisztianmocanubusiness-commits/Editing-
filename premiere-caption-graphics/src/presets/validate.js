const clamp = (v, min, max) => Math.min(max, Math.max(min, Number(v)));

/**
 * Clamp a preset's numeric fields into safe ranges after UI edits, so a
 * stray typed value (e.g. weight 5000, opacity -30) can't get pushed into
 * Premiere. Mutates and returns the same object.
 */
export function clampPreset(preset) {
  preset.font.size = clamp(preset.font.size, 8, 400);
  preset.font.weight = clamp(preset.font.weight, 100, 900);
  preset.color.opacity = clamp(preset.color.opacity, 0, 100);
  preset.gradient.angleDeg = clamp(preset.gradient.angleDeg, 0, 360);
  preset.backgroundBox.opacity = clamp(preset.backgroundBox.opacity, 0, 100);
  preset.backgroundBox.cornerRadius = clamp(preset.backgroundBox.cornerRadius, 0, 200);
  preset.backgroundBox.paddingX = clamp(preset.backgroundBox.paddingX, 0, 400);
  preset.backgroundBox.paddingY = clamp(preset.backgroundBox.paddingY, 0, 400);
  preset.position.safeMarginPct = clamp(preset.position.safeMarginPct, 0, 40);
  preset.tracking = clamp(preset.tracking, -200, 1000);
  preset.shadow.opacity = clamp(preset.shadow.opacity, 0, 100);
  preset.shadow.angleDeg = clamp(preset.shadow.angleDeg, 0, 360);
  preset.shadow.distance = clamp(preset.shadow.distance, 0, 200);
  preset.shadow.softness = clamp(preset.shadow.softness, 0, 200);
  preset.blur.amount = clamp(preset.blur.amount, 0, 200);
  preset.animation.entrance.durationMs = clamp(preset.animation.entrance.durationMs, 0, 5000);
  preset.animation.exit.durationMs = clamp(preset.animation.exit.durationMs, 0, 5000);
  preset.emphasis.scale = clamp(preset.emphasis.scale, 0.5, 3);
  preset.emphasis.weightBoost = clamp(preset.emphasis.weightBoost, 0, 500);
  return preset;
}

export function isValidHexColor(value) {
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}
