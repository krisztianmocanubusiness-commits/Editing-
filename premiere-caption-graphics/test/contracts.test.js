import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { KERIS_CAPTION_V1, KERIS_CAPTION_V1_PPRO, getContract, CONTRACTS } from "../src/presets/contracts/index.js";
import { resolveParamName, flattenPresetForMogrt } from "../src/presets/mogrtContract.js";
import {
  validateAgainstContract,
  describeCompliance,
  describeCompatibilityLabel,
  extraParams,
  detectContract,
} from "../src/presets/contractValidation.js";
import { createDefaultPreset } from "../src/presets/types.js";
import { makeChunk } from "../src/caption/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = path.join(__dirname, "../mogrt-contracts");
const PRESETS_DIR = path.join(CONTRACTS_DIR, "presets");
const GUIDE_PATH = path.join(__dirname, "../mogrt-authoring/PREMIERE_ONLY_GUIDE.md");

function boundPreset(overrides = {}) {
  const preset = createDefaultPreset("Test");
  preset.mogrt.contractId = "KERIS_CAPTION_V1";
  Object.assign(preset, overrides);
  return preset;
}

function boundPresetPpro(overrides = {}) {
  const preset = createDefaultPreset("Test");
  preset.mogrt.contractId = "KERIS_CAPTION_V1_PPRO";
  Object.assign(preset, overrides);
  return preset;
}

test("KERIS_CAPTION_V1.requiredParams and paramMap values never drift apart", () => {
  const fromMap = new Set(Object.values(KERIS_CAPTION_V1.paramMap));
  const fromRequired = new Set(KERIS_CAPTION_V1.requiredParams);
  assert.deepEqual(fromMap, fromRequired);
  assert.equal(KERIS_CAPTION_V1.requiredParams.length, 10, "spec calls for exactly 10 required params");
});

test("KERIS_CAPTION_V1.compatibility is after-effects", () => {
  assert.equal(KERIS_CAPTION_V1.compatibility, "after-effects");
});

test("KERIS_CAPTION_V1_PPRO.requiredParams has exactly the 8 spec'd params", () => {
  assert.deepEqual(KERIS_CAPTION_V1_PPRO.requiredParams, [
    "Text",
    "Font Size",
    "Fill Color",
    "Position",
    "Background Opacity",
    "Background Color",
    "Tracking",
    "Shadow Opacity",
  ]);
  assert.equal(KERIS_CAPTION_V1_PPRO.requiredParams.length, 8);
});

test("KERIS_CAPTION_V1_PPRO.compatibility is premiere-only", () => {
  assert.equal(KERIS_CAPTION_V1_PPRO.compatibility, "premiere-only");
});

test("KERIS_CAPTION_V1_PPRO.paramMap values are exactly requiredParams plus the recommended optional Fill Opacity", () => {
  const fromMap = new Set(Object.values(KERIS_CAPTION_V1_PPRO.paramMap));
  const fromRequired = new Set(KERIS_CAPTION_V1_PPRO.requiredParams);
  const expected = new Set([...fromRequired, "Fill Opacity"]);
  assert.deepEqual(fromMap, expected);
});

test("KERIS_CAPTION_V1_PPRO.recommendedOptionalParams lists Fill Opacity, and it is not required", () => {
  assert.deepEqual(KERIS_CAPTION_V1_PPRO.recommendedOptionalParams, ["Fill Opacity"]);
  assert.ok(!KERIS_CAPTION_V1_PPRO.requiredParams.includes("Fill Opacity"));
});

test("KERIS_CAPTION_V1_PPRO.paramMap maps both positionX and positionY to the single combined Position control", () => {
  assert.equal(KERIS_CAPTION_V1_PPRO.paramMap.positionX, "Position");
  assert.equal(KERIS_CAPTION_V1_PPRO.paramMap.positionY, "Position");
});

test("KERIS_CAPTION_V1_PPRO.paramMap does not map animationStyleIndex (no Entrance Style in Premiere-only contract)", () => {
  assert.equal(KERIS_CAPTION_V1_PPRO.paramMap.animationStyleIndex, undefined);
  assert.ok(!KERIS_CAPTION_V1_PPRO.requiredParams.includes("Entrance Style"));
});

test("CONTRACTS registry registers KERIS_CAPTION_V1_PPRO first (detection preference) and both ids resolve", () => {
  assert.deepEqual(Object.keys(CONTRACTS), ["KERIS_CAPTION_V1_PPRO", "KERIS_CAPTION_V1"]);
});

test("getContract resolves a known id and returns null for an unknown one", () => {
  assert.equal(getContract("KERIS_CAPTION_V1"), KERIS_CAPTION_V1);
  assert.equal(getContract("KERIS_CAPTION_V1_PPRO"), KERIS_CAPTION_V1_PPRO);
  assert.equal(getContract("NOT_A_REAL_CONTRACT"), null);
});

test("describeCompatibilityLabel gives the plain-English tier for each contract, and a safe default", () => {
  assert.equal(describeCompatibilityLabel(KERIS_CAPTION_V1_PPRO), "Premiere-only compatible");
  assert.equal(describeCompatibilityLabel(KERIS_CAPTION_V1), "After Effects / full contract");
  assert.equal(describeCompatibilityLabel(null), "Unknown");
  assert.equal(describeCompatibilityLabel({}), "Unknown");
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

test("resolveParamName priority for a KERIS_CAPTION_V1_PPRO-bound preset", () => {
  const preset = boundPresetPpro();
  assert.equal(resolveParamName(preset, "fontSize"), "Font Size");
  assert.equal(resolveParamName(preset, "positionX"), "Position");
  assert.equal(resolveParamName(preset, "positionY"), "Position");
  assert.equal(resolveParamName(preset, "fillOpacity"), "Fill Opacity");
  // Not mapped by this contract, so it falls through to the generic fallback.
  assert.equal(resolveParamName(preset, "animationStyleIndex"), "Animation Style");
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

  // KERIS_CAPTION_V1 splits position: two "number"-kind instructions, no combined "point" one.
  const positionInstrs = flattened.filter((i) => i.fieldKey === "positionX" || i.fieldKey === "positionY");
  assert.equal(positionInstrs.length, 2);
  assert.ok(positionInstrs.every((i) => i.kind === "number"));
  assert.ok(!flattened.some((i) => i.kind === "point"));
});

test("flattenPresetForMogrt resolves all 8 KERIS_CAPTION_V1_PPRO required params, emitting one combined Position point instruction", () => {
  const preset = boundPresetPpro({
    backgroundBox: { enabled: true, color: "#F1E3CE", opacity: 90, cornerRadius: 10, paddingX: 20, paddingY: 10 },
    shadow: { enabled: true, color: "#000000", opacity: 50, angleDeg: 135, distance: 5, softness: 8 },
  });
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "hello", start: 0, end: 1 }] });

  const flattened = flattenPresetForMogrt(preset, chunk);
  const paramNamesUsed = new Set(flattened.map((i) => i.paramName));

  for (const required of KERIS_CAPTION_V1_PPRO.requiredParams) {
    assert.ok(paramNamesUsed.has(required), `expected flatten output to include contract param "${required}"`);
  }

  const positionInstrs = flattened.filter((i) => i.fieldKey === "position");
  assert.equal(positionInstrs.length, 1);
  assert.equal(positionInstrs[0].kind, "point");
  assert.equal(positionInstrs[0].paramName, "Position");
  assert.deepEqual(positionInstrs[0].value, { x: preset.position.offsetX, y: preset.position.offsetY });

  // No split positionX/positionY instructions for a PPRO-bound preset.
  assert.ok(!flattened.some((i) => i.fieldKey === "positionX" || i.fieldKey === "positionY"));
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

test("validateAgainstContract reports exactly which KERIS_CAPTION_V1_PPRO required params are missing", () => {
  const discovered = ["Text", "Font Size", "Fill Color"]; // missing 5 of 8
  const result = validateAgainstContract(discovered, KERIS_CAPTION_V1_PPRO);

  assert.equal(result.isCompliant, false);
  assert.deepEqual(result.presentRequired, ["Text", "Font Size", "Fill Color"]);
  assert.deepEqual(
    result.missingRequired,
    ["Position", "Background Opacity", "Background Color", "Tracking", "Shadow Opacity"]
  );

  const message = describeCompliance(result);
  assert.match(message, /NOT COMPLIANT/);
  assert.match(message, /Position/);
});

test("validateAgainstContract reports KERIS_CAPTION_V1_PPRO compliant without Fill Opacity or Entrance Style (both absent from its required list)", () => {
  const discovered = KERIS_CAPTION_V1_PPRO.requiredParams; // no Fill Opacity, no Entrance Style
  const result = validateAgainstContract(discovered, KERIS_CAPTION_V1_PPRO);
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

test("PREMIERE_ONLY_GUIDE.md documents every KERIS_CAPTION_V1_PPRO required param, plus the recommended optional Fill Opacity", () => {
  const doc = fs.readFileSync(GUIDE_PATH, "utf8");
  for (const name of KERIS_CAPTION_V1_PPRO.requiredParams) {
    assert.ok(doc.includes(`\`${name}\``), `guide should mention required param "${name}"`);
  }
  for (const name of KERIS_CAPTION_V1_PPRO.recommendedOptionalParams) {
    assert.ok(doc.includes(`\`${name}\``), `guide should mention recommended optional param "${name}"`);
  }
});

for (const file of EXAMPLE_PRESET_FILES) {
  test(`example preset ${file} is valid, KERIS_CAPTION_V1_PPRO-bound JSON with every core field always resolvable`, () => {
    const raw = fs.readFileSync(path.join(PRESETS_DIR, file), "utf8");
    const preset = JSON.parse(raw);

    assert.equal(preset.mogrt.contractId, "KERIS_CAPTION_V1_PPRO");
    assert.equal(typeof preset.id, "string");
    assert.equal(typeof preset.name, "string");
    assert.ok(preset.font && preset.color && preset.position && preset.shadow && preset.animation);

    const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "test", start: 0, end: 1 }] });
    const flattened = flattenPresetForMogrt(preset, chunk);
    const paramNamesUsed = new Set(flattened.map((i) => i.paramName));

    // These fields are unconditional in flattenPresetForMogrt, so every
    // PPRO-bound preset — regardless of which optional sections it toggles
    // on — must resolve them to the contract's exact names. Position
    // resolves to the single combined "Position" control, not split X/Y,
    // and there's no Entrance Style in this contract.
    for (const alwaysOn of ["Text", "Font Size", "Fill Color", "Position", "Tracking"]) {
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

test("extraParams reports discovered names beyond the contract's required list", () => {
  const discovered = [...KERIS_CAPTION_V1.requiredParams, "Custom Glow Amount", "Logo Visible"];
  const extras = extraParams(discovered, KERIS_CAPTION_V1);
  assert.deepEqual(extras.sort(), ["Custom Glow Amount", "Logo Visible"]);
});

test("extraParams treats every discovered name as extra when no contract is given", () => {
  const discovered = ["Text", "Whatever"];
  assert.deepEqual(extraParams(discovered, null), discovered);
});

test("extraParams reports discovered names beyond KERIS_CAPTION_V1_PPRO's required list (Fill Opacity counts as extra, since it's optional not required)", () => {
  const discovered = [...KERIS_CAPTION_V1_PPRO.requiredParams, "Fill Opacity", "Custom Glow Amount"];
  const extras = extraParams(discovered, KERIS_CAPTION_V1_PPRO);
  assert.deepEqual(extras.sort(), ["Custom Glow Amount", "Fill Opacity"]);
});

test("detectContract finds an exact match against the registry", () => {
  const detection = detectContract(KERIS_CAPTION_V1.requiredParams, CONTRACTS);
  assert.equal(detection.detectedContractId, "KERIS_CAPTION_V1");
  assert.equal(detection.isExactMatch, true);
});

test("detectContract finds an exact match for a native Premiere MOGRT exposing exactly the KERIS_CAPTION_V1_PPRO params", () => {
  const detection = detectContract(KERIS_CAPTION_V1_PPRO.requiredParams, CONTRACTS);
  assert.equal(detection.detectedContractId, "KERIS_CAPTION_V1_PPRO");
  assert.equal(detection.isExactMatch, true);
  assert.equal(detection.bestGuessContractId, "KERIS_CAPTION_V1_PPRO");
});

test("detectContract still finds KERIS_CAPTION_V1_PPRO even when it's checked after KERIS_CAPTION_V1 fails (registry order doesn't skip later contracts)", () => {
  // A template exposing only PPRO's 8 params is NOT compliant with the
  // fuller KERIS_CAPTION_V1 (missing Position X/Y and Entrance Style), but
  // detectContract must still walk the rest of the registry and find PPRO.
  const discovered = KERIS_CAPTION_V1_PPRO.requiredParams;
  assert.equal(validateAgainstContract(discovered, KERIS_CAPTION_V1).isCompliant, false);
  const detection = detectContract(discovered, CONTRACTS);
  assert.equal(detection.detectedContractId, "KERIS_CAPTION_V1_PPRO");
});

test("detectContract reports the closest partial match when nothing is fully compliant", () => {
  const partial = KERIS_CAPTION_V1.requiredParams.slice(0, 4); // 4 of 10
  const detection = detectContract(partial, CONTRACTS);
  assert.equal(detection.detectedContractId, null);
  assert.equal(detection.isExactMatch, false);
  assert.equal(detection.bestGuessContractId, "KERIS_CAPTION_V1");
});

test("detectContract prefers KERIS_CAPTION_V1_PPRO as the best guess when a partial template's params overlap it more than KERIS_CAPTION_V1", () => {
  // "Position" (PPRO) matches 4/8 required PPRO params; none of KERIS_CAPTION_V1's
  // required params include "Position" (it has split Position X/Position Y instead),
  // so KERIS_CAPTION_V1 only picks up the other 3 shared names.
  const partial = ["Text", "Font Size", "Fill Color", "Position"];
  const detection = detectContract(partial, CONTRACTS);
  assert.equal(detection.detectedContractId, null);
  assert.equal(detection.isExactMatch, false);
  assert.equal(detection.bestGuessContractId, "KERIS_CAPTION_V1_PPRO");
});

test("detectContract handles an empty registry without throwing", () => {
  const detection = detectContract(["Text"], {});
  assert.equal(detection.detectedContractId, null);
  assert.equal(detection.bestGuessContractId, null);
  assert.deepEqual(detection.evaluations, []);
});
