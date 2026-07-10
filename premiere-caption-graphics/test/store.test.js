import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../src/state/store.js";

// Regression test for a real, reproduced bug: in Premiere Pro 26.3,
// clicking "Choose test .mogrt…" under "0. Host smoke test" — BEFORE ever
// clicking "Run Smoke Test" — threw "Cannot read properties of undefined
// (reading 'running')" from src/ui/templateInspectorPanel.js.
//
// Root cause: store.set()'s function-updater branch did `state =
// patch(state)`, which REPLACES the entire store with whatever object the
// updater returns, rather than merging it. src/ui/smokeTestPanel.js's file
// picker calls `store.set((s) => ({ smokeTest: { ...s.smokeTest, mogrtPath
// } }))` — a partial update by every convention this codebase otherwise
// follows (the plain-object form of set() already merges) — so that single
// call silently wiped every other top-level key, including
// `templateInspector`. The next re-render then read `.running` off
// `state.templateInspector`, now undefined. This had nothing to do with
// which panel section had been visited or run first; any function-form
// set() call anywhere would have wiped the rest of the store the same way
// (see src/ui/chunkListPanel.js and src/ui/presetPanel.js, which use the
// same pattern).

test("store.set(updaterFn) merges the updater's return value into existing state, it does not replace state wholesale", () => {
  const store = createStore({ a: 1, b: { nested: true } });

  store.set((s) => ({ b: { ...s.b, nested: false } }));

  const state = store.getState();
  assert.equal(state.a, 1, "a prior top-level key must survive a later function-form set()");
  assert.deepEqual(state.b, { nested: false });
});

test("store.set(updaterFn) behaves identically to the plain-object form for merging", () => {
  const viaObject = createStore({ a: 1, b: 2 });
  viaObject.set({ b: 20 });

  const viaFunction = createStore({ a: 1, b: 2 });
  viaFunction.set(() => ({ b: 20 }));

  assert.deepEqual(viaObject.getState(), viaFunction.getState());
});

test("reproduces the exact reported bug: patching smokeTest before ever touching templateInspector must not wipe templateInspector", () => {
  // Mirrors the real store's initial shape for the two panels involved.
  const store = createStore({
    templateInspector: { mogrtPath: "", running: false, lastResult: null },
    smokeTest: { mogrtPath: "", running: false, lastResult: null, lastCompliance: null },
  });

  // This is the exact pattern from patchSmokeTest() in
  // src/ui/smokeTestPanel.js — the "Choose test .mogrt…" handler's state
  // update, called before "Run Smoke Test" has ever been pressed, and
  // before templateInspector has ever been touched.
  store.set((s) => ({ smokeTest: { ...s.smokeTest, mogrtPath: "/fake/test.mogrt" } }));

  const state = store.getState();
  assert.equal(state.smokeTest.mogrtPath, "/fake/test.mogrt");
  assert.ok(state.templateInspector, "templateInspector must still exist after an unrelated smokeTest patch");
  assert.equal(state.templateInspector.running, false, "reading .running on templateInspector must not throw");
});

test("multiple function-form set() calls in a row keep accumulating, not replacing", () => {
  const store = createStore({ chunks: [], activePreset: { mogrt: { path: "" } }, smokeTest: { running: false } });

  store.set((s) => ({ chunks: [...s.chunks, "chunk-1"] }));
  store.set((s) => ({ activePreset: { ...s.activePreset, mogrt: { ...s.activePreset.mogrt, path: "/a.mogrt" } } }));
  store.set((s) => ({ smokeTest: { ...s.smokeTest, running: true } }));

  const state = store.getState();
  assert.deepEqual(state.chunks, ["chunk-1"]);
  assert.equal(state.activePreset.mogrt.path, "/a.mogrt");
  assert.equal(state.smokeTest.running, true);
});
