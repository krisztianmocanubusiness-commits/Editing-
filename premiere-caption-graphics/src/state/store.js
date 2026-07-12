import { BUILT_IN_PRESETS } from "../presets/library.js";
import { clonePreset } from "../presets/types.js";
import { DEFAULT_CHUNK_OPTIONS } from "../caption/chunker.js";
import { loadActiveTemplate } from "./settings.js";

/**
 * Minimal observable store for the panel. No framework: subscribers are
 * plain callbacks re-run on every `set`. The panel is small enough that a
 * full render-on-any-change pass is cheap and easy to reason about.
 */
export function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  return {
    getState: () => state,
    // `patch` may be a plain object OR an updater function — either way it
    // is treated as a *partial* update and merged into existing state, the
    // same as the object form. It must never replace state wholesale: every
    // call site in src/ui/ (smokeTestPanel.js, templateInspectorPanel.js,
    // chunkListPanel.js, presetPanel.js) calls `store.set((s) => ({ someKey:
    // {...} }))` expecting only `someKey` to change — anything else returned
    // by `patch` at the top level is merged in, not swapped in for the rest
    // of the store. (Previously `patch(state)`'s return value replaced
    // `state` outright, silently deleting every other top-level key on the
    // very next function-form set() call — see test/store.test.js.)
    set(patch) {
      const partial = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...partial };
      listeners.forEach((fn) => fn(state));
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export const store = createStore({
  project: null,
  sequence: null,
  videoTrackIndex: 1,
  videoTracks: [],

  range: { startSec: 0, endSec: 0 },

  transcript: null, // { words, sourceFormat, hasWordTiming }
  transcriptLabel: "No transcript loaded",

  chunkOptions: { ...DEFAULT_CHUNK_OPTIONS },
  chunks: [],
  selectedChunkId: null,

  presetLibrary: BUILT_IN_PRESETS,
  activePreset: clonePreset(BUILT_IN_PRESETS[0]),

  applying: false,

  smokeTest: {
    mogrtPath: "",
    text: "Smoke Test Caption",
    fontSize: 72,
    fillColor: "#FFFFFF",
    positionX: 960,
    positionY: 980,
    running: false,
    lastResult: null, // "pass" | "fail" | "partial" | null
    lastCompliance: null, // result of validateAgainstContract(), or null
    lastCoreFields: null, // string[] of field names counted toward lastResult, or null
  },

  // { path, contractId, compliant, savedAt } | null — see src/state/settings.js.
  // Loaded once at startup; templateInspectorPanel.js is the only writer.
  activeTemplate: loadActiveTemplate(),

  templateInspector: {
    mogrtPath: "",
    running: false,
    lastResult: null, // full inspectMogrt() return value, or null
    diagnosing: false,
    lastDiagnostic: null, // full diagnoseMogrt() return value, or null — see src/ppro/diagnostics.js
    sourceTextRoundTripRunning: false,
    lastSourceTextRoundTrip: null, // full testSourceTextRoundTrip() return value, or null — see src/ppro/sourceTextProbe.js
    readSourceTextOnlyRunning: false,
    lastReadSourceTextOnly: null, // full testReadSourceTextOnly() return value, or null — see src/ppro/sourceTextProbe.js
    exploreKeyframeObjectRunning: false,
    lastExploreKeyframeObject: null, // full testExploreKeyframeObject() return value, or null — see src/ppro/sourceTextProbe.js
  },
});
