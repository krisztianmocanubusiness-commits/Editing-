import { BUILT_IN_PRESETS } from "../presets/library.js";
import { clonePreset } from "../presets/types.js";
import { DEFAULT_CHUNK_OPTIONS } from "../caption/chunker.js";

/**
 * Minimal observable store for the panel. No framework: subscribers are
 * plain callbacks re-run on every `set`. The panel is small enough that a
 * full render-on-any-change pass is cheap and easy to reason about.
 */
function createStore(initialState) {
  let state = initialState;
  const listeners = new Set();

  return {
    getState: () => state,
    set(patch) {
      state = typeof patch === "function" ? patch(state) : { ...state, ...patch };
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
});
