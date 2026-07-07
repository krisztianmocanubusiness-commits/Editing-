import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultPreset } from "../src/presets/types.js";
import { clampPreset } from "../src/presets/validate.js";
import { flattenPresetForMogrt, resolveParamName, CANONICAL_PARAMS } from "../src/presets/mogrtContract.js";
import { makeChunk } from "../src/caption/types.js";

test("clampPreset keeps out-of-range values in bounds", () => {
  const preset = createDefaultPreset("Test");
  preset.font.weight = 5000;
  preset.color.opacity = -30;
  preset.tracking = 99999;
  clampPreset(preset);
  assert.equal(preset.font.weight, 900);
  assert.equal(preset.color.opacity, 0);
  assert.equal(preset.tracking, 1000);
});

test("resolveParamName falls back to canonical name unless overridden", () => {
  const preset = createDefaultPreset("Test");
  assert.equal(resolveParamName(preset, "fontSize"), CANONICAL_PARAMS.fontSize);
  preset.mogrt.paramMap.fontSize = "My Custom Size Control";
  assert.equal(resolveParamName(preset, "fontSize"), "My Custom Size Control");
});

test("flattenPresetForMogrt includes emphasis fields only when enabled and chunk has keywords", () => {
  const preset = createDefaultPreset("Test");
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "secret", start: 0, end: 1 }] });
  chunk.keywords = ["secret"];

  const withEmphasis = flattenPresetForMogrt(preset, chunk);
  assert.ok(withEmphasis.some((i) => i.fieldKey === "emphasisText"));

  chunk.emphasisOn = false;
  const withoutEmphasis = flattenPresetForMogrt(preset, chunk);
  assert.ok(!withoutEmphasis.some((i) => i.fieldKey === "emphasisText"));
});

test("flattenPresetForMogrt skips optional sections that are disabled", () => {
  const preset = createDefaultPreset("Test");
  preset.gradient.enabled = false;
  preset.backgroundBox.enabled = false;
  preset.shadow.enabled = false;
  preset.blur.enabled = false;
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "hi", start: 0, end: 1 }] });

  const flattened = flattenPresetForMogrt(preset, chunk);
  assert.ok(!flattened.some((i) => i.fieldKey === "gradientStartColor"));
  assert.ok(!flattened.some((i) => i.fieldKey === "bgBoxColor"));
  assert.ok(!flattened.some((i) => i.fieldKey === "shadowColor"));
  assert.ok(!flattened.some((i) => i.fieldKey === "blurAmount"));
});
