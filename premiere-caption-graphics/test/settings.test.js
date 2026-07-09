import { test } from "node:test";
import assert from "node:assert/strict";
import { loadActiveTemplate, saveActiveTemplate, clearActiveTemplate } from "../src/state/settings.js";

// This suite runs under plain Node, where `localStorage` is undefined, so it
// exercises settings.js's in-memory fallback path — the same code path a
// UXP host without Web Storage support would hit. See docs/TEMPLATE_INSPECTOR.md
// for why this matters: settings.js has never been confirmed against a real
// UXP panel's localStorage, so it must degrade gracefully instead of throwing.

test("loadActiveTemplate returns null before anything has been saved", () => {
  clearActiveTemplate();
  assert.equal(loadActiveTemplate(), null);
});

test("saveActiveTemplate round-trips through loadActiveTemplate", () => {
  const result = saveActiveTemplate({ path: "/tmp/test.mogrt", contractId: "KERIS_CAPTION_V1", compliant: true });
  assert.equal(result.ok, true);

  const loaded = loadActiveTemplate();
  assert.equal(loaded.path, "/tmp/test.mogrt");
  assert.equal(loaded.contractId, "KERIS_CAPTION_V1");
  assert.equal(loaded.compliant, true);
  assert.equal(typeof loaded.savedAt, "string");
});

test("saveActiveTemplate defaults contractId to null and compliant to false when omitted", () => {
  const result = saveActiveTemplate({ path: "/tmp/other.mogrt" });
  assert.equal(result.value.contractId, null);
  assert.equal(result.value.compliant, false);
});

test("clearActiveTemplate resets to null", () => {
  saveActiveTemplate({ path: "/tmp/test.mogrt", contractId: "KERIS_CAPTION_V1" });
  clearActiveTemplate();
  assert.equal(loadActiveTemplate(), null);
});
