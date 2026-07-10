import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyComponent, readMatchName, textLikeSignal } from "../src/ppro/diagnostics.js";

test("classifyComponent recognizes the known intrinsic component names, case-insensitively", () => {
  for (const name of ["Motion", "opacity", "Time Remapping", "CROP", "Channel Volume", "Volume"]) {
    const { classification } = classifyComponent({ displayName: name, matchName: null });
    assert.equal(classification, "intrinsic", `expected "${name}" to classify as intrinsic`);
  }
});

test("classifyComponent flags graphic/MOGRT signals in displayName or matchName", () => {
  assert.equal(classifyComponent({ displayName: "Graphic", matchName: null }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Essential Graphics", matchName: null }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Text", matchName: "AE.ADBE Text" }).classification, "graphic-or-mogrt");
  assert.equal(classifyComponent({ displayName: "Some MOGRT Layer", matchName: null }).classification, "graphic-or-mogrt");
});

test("classifyComponent falls back to effect-or-unknown for anything unrecognized", () => {
  const result = classifyComponent({ displayName: "Gaussian Blur", matchName: null });
  assert.equal(result.classification, "effect-or-unknown");
  assert.match(result.reason, /human judgment/);
});

test("classifyComponent does not misclassify a param-level name (e.g. Scale) as intrinsic just because it sounds related", () => {
  // "Scale" is a *param* under the "Motion" component in real Premiere usage,
  // not a component name itself — classifyComponent only recognizes exact
  // known component names, so a caller passing a param name here should not
  // silently get "intrinsic".
  assert.equal(classifyComponent({ displayName: "Scale", matchName: null }).classification, "effect-or-unknown");
});

test("readMatchName tries a property first, then a getMatchName() method, and reports which worked", () => {
  assert.deepEqual(readMatchName({ matchName: "AE.ADBE Text" }), { value: "AE.ADBE Text", source: "matchName (property)" });
  assert.deepEqual(readMatchName({ getMatchName: () => "AE.ADBE Position" }), {
    value: "AE.ADBE Position",
    source: "getMatchName() (method)",
  });
  assert.deepEqual(readMatchName({}), { value: null, source: null });
});

test("readMatchName never throws even if the accessor itself throws", () => {
  const poison = {
    get matchName() {
      throw new Error("boom");
    },
  };
  assert.doesNotThrow(() => readMatchName(poison));
  assert.deepEqual(readMatchName(poison), { value: null, source: null });
});

test("textLikeSignal matches on either displayName or matchName containing text-related words", () => {
  assert.equal(textLikeSignal("Source Text", null), true);
  assert.equal(textLikeSignal("Whatever", "AE.ADBE Text"), true);
  assert.equal(textLikeSignal("Font Size", null), false);
  assert.equal(textLikeSignal(null, null), false);
});
