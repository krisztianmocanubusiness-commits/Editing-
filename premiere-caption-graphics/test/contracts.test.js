import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KERIS_CAPTION_V1, getContract } from "../src/presets/contracts/index.js";
import { resolveParamName, flattenPresetForMogrt } from "../src/presets/mogrtContract.js";
import { validateAgainstContract, describeCompliance } from "../src/presets/contractValidation.js";
import { createDefaultPreset } from "../src/presets/types.js";
import { makeChunk } from "../src/caption/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.join(__dirname, "../mogrt-contracts");
const PRESETS_DIR = path.join(CONTRACTS_DIR, "presets");

function boundPreset(overrides = {}) {
  const preset = createDefaultPreset("Test");
  preset.mogrt.contractId = "KERIS_CAPTION_V1";
  Object.assign(preset, overrides);
  return preset;
}

test("KERIS_CAPTION_V1.requiredParams and paramMap values never drift apart", () => {
  const fromMap = new Set(Object.values(KERIS_CAPTION_V1.paramMap));
  const fromRequired = new Set(KERIS_CAPTION_V1.requiredParams);
  assert.deepEqual(fromMap, fromRequired);
  assert.equal(KERIS_CAPTION_V1.requiredParams.length, 10, "spec calls for exactly 10 required params");
});

test("getContract resolves a known id and returns null for an unknown one", () => {
  assert.equal(getContract("KERIS_CAPTION_V1"), KERIS_CAPTION_V1);
  assert.equal(getContract("NOT_A_REAL_CONTRACT"), null);
});

test("resolveParamName priority: explicit override > contract > generic canonical", () => {
  const preset = boundPreset();
  // 2. Contract-provided name, since no override yet.
  assert.equal(resolveParamName(preset, "fontSize"), "Font Size");
  assert.equal(resolveParamName(preset, "positionX"), "Position X");

  // 3. Falls through to the generic fallback for a field the contract doesn't map.
  assert.equal(resolveParamName(preset, "blurAmount"), "Blur Amount");

  // 1. An explicit per-preset override always wins.
  preset.mogrt.paramMap.fontSize = "My Custom Size";
  assert.equal(resolveParamName(preset, "fontSize"), "My Custom Size");
});

test("a preset with no contractId falls back to the generic CANONICAL_PARAMS names", () => {
  const preset = createDefaultPreset("Unbound");
  assert.equal(resolveParamName(preset, "captionText"), "Caption Text");
  assert.equal(resolveParamName(preset, "fontSize"), "Font Size");
});

test("flattenPresetForMogrt resolves all 10 KERIS_CAPTION_V1 required params to their contract names when a preset exercises every optional section", () => {
  const preset = boundPreset({
    backgroundBox: { enabled: true, color: "#F1E3CE", opacity: 90, cornerRadius: 10, paddingX: 20, paddingY: 10 },
    shadow: { enabled: true, color: "#000000", opacity: 50, angleDeg: 135, distance: 5, softness: 8 },
  });
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "hello", start: 0, end: 1 }] });

  const flattened = flattenPresetForMogrt(preset, chunk);
  const paramNamesUsed = new Set(flattened.map((i) => i.paramName));

  for (const required of KERIS_CAPTION_V1.requiredParams) {
    assert.ok(paramNamesUsed.has(required), `expected flatten output to include contract param "${required}"`);
  }
});

test("validateAgainstContract reports exactly which required params are missing", () => {
  const discovered = ["Text", "Font Size", "Fill Color", "Position X"]; // missing 6 of 10
  const result = validateAgainstContract(discovered, KERIS_CAPTION_V1);

  assert.equal(result.isCompliant, false);
  assert.deepEqual(result.presentRequired, ["Text", "Font Size", "Fill Color", "Position X"]);
  assert.deepEqual(
    result.missingRequired,
    ["Position Y", "Background Opacity", "Background Color", "Tracking", "Shadow Opacity", "Entrance Style"]
  );

  const message = describeCompliance(result);
  assert.match(message, /NOT COMPLIANT/);
  assert.match(message, /Entrance Style/);
});

test("validateAgainstContract reports compliant when every required param is present (extras ignored)", () => {
  const discovered = [...KERIS_CAPTION_V1.requiredParams, "Some Extra Slider"];
  const result = validateAgainstContract(discovered, KERIS_CAPTION_V1);
  assert.equal(result.isCompliant, true);
  assert.equal(result.missingRequired.length, 0);
  assert.match(describeCompliance(result), /COMPLIANT/);
});

const EXAMPLE_PRESET_FILES = [
  "white-clean-subtitle.json",
  "blue-keyword.json",
  "yellow-impact-word.json",
  "beige-background-card.json",
];

test("KERIS_CAPTION_V1.md documents exactly the 10 required param names", () => {
  const doc = fs.readFileSync(path.join(CONTRACTS_DIR, "KERIS_CAPTION_V1.md"), "utf8");
  for (const name of KERIS_CAPTION_V1.requiredParams) {
    assert.ok(doc.includes(`\`${name}\``), `doc should mention required param "${name}"`);
  }
});

for (const file of EXAMPLE_PRESET_FILES) {
  test(`example preset ${file} is valid, contract-bound JSON with every core field always resolvable`, () => {
    const raw = fs.readFileSync(path.join(PRESETS_DIR, file), "utf8");
    const preset = JSON.parse(raw);

    assert.equal(preset.mogrt.contractId, "KERIS_CAPTION_V1");
    assert.equal(typeof preset.id, "string");
    assert.equal(typeof preset.name, "string");
    assert.ok(preset.font && preset.color && preset.position && preset.shadow && preset.animation);

    const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "test", start: 0, end: 1 }] });
    const flattened = flattenPresetForMogrt(preset, chunk);
    const paramNamesUsed = new Set(flattened.map((i) => i.paramName));

    // These fields are unconditional in flattenPresetForMogrt, so every
    // contract-bound preset — regardless of which optional sections it
    // toggles on — must resolve them to the contract's exact names.
    for (const alwaysOn of ["Text", "Font Size", "Fill Color", "Position X", "Position Y", "Tracking", "Entrance Style"]) {
      assert.ok(paramNamesUsed.has(alwaysOn), `${file}: expected "${alwaysOn}" in flattened output`);
    }
  });
}

test("beige-background-card.json (the one with backgroundBox enabled) resolves Background Opacity/Color to contract names", () => {
  const preset = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, "beige-background-card.json"), "utf8"));
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "test", start: 0, end: 1 }] });
  const flattened = flattenPresetForMogrt(preset, chunk);
  const paramNamesUsed = new Set(flattened.map((i) => i.paramName));
  assert.ok(paramNamesUsed.has("Background Opacity"));
  assert.ok(paramNamesUsed.has("Background Color"));
});
