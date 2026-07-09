import { test } from "node:test";
import assert from "node:assert/strict";
import { createDefaultPreset } from "../src/presets/types.js";
import { withActiveTemplateFallback } from "../src/presets/effectiveMogrt.js";

test("withActiveTemplateFallback fills in path/contractId when the preset has none", () => {
  const preset = createDefaultPreset("Test");
  const activeTemplate = { path: "/active/template.mogrt", contractId: "KERIS_CAPTION_V1" };

  const effective = withActiveTemplateFallback(preset, activeTemplate);
  assert.equal(effective.mogrt.path, "/active/template.mogrt");
  assert.equal(effective.mogrt.contractId, "KERIS_CAPTION_V1");
});

test("withActiveTemplateFallback never overrides a preset's own template", () => {
  const preset = createDefaultPreset("Test");
  preset.mogrt.path = "/own/template.mogrt";
  preset.mogrt.contractId = "SOME_OTHER_CONTRACT";
  const activeTemplate = { path: "/active/template.mogrt", contractId: "KERIS_CAPTION_V1" };

  const effective = withActiveTemplateFallback(preset, activeTemplate);
  assert.equal(effective.mogrt.path, "/own/template.mogrt");
  assert.equal(effective.mogrt.contractId, "SOME_OTHER_CONTRACT");
});

test("withActiveTemplateFallback leaves the preset untouched when there's no active template", () => {
  const preset = createDefaultPreset("Test");
  const effective = withActiveTemplateFallback(preset, null);
  assert.equal(effective.mogrt.path, "");
  assert.equal(effective, preset, "should return the same reference, not a needless clone");
});

test("withActiveTemplateFallback does not mutate the original preset", () => {
  const preset = createDefaultPreset("Test");
  const activeTemplate = { path: "/active/template.mogrt", contractId: "KERIS_CAPTION_V1" };
  withActiveTemplateFallback(preset, activeTemplate);
  assert.equal(preset.mogrt.path, "", "original preset must be unaffected");
});
