import { el, numberInput, checkboxInput } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { chunkWords, clipChunksToRange, fitWordsToRange } from "../caption/chunker.js";
import { pickEmphasisWords } from "../caption/keywords.js";

function regenerate() {
  const { transcript, range, chunkOptions } = store.getState();
  if (!transcript || transcript.words.length === 0) {
    log("Load a transcript first.", "error");
    return;
  }
  if (range.endSec <= range.startSec) {
    log("Read the sequence's in/out range first (or set an in/out in Premiere).", "error");
    return;
  }

  const hasRealTiming = transcript.hasWordTiming && transcript.words.some((w) => w.end > w.start);
  const words = hasRealTiming ? transcript.words : fitWordsToRange(transcript.words, range.startSec, range.endSec);

  const rawChunks = chunkWords(words, chunkOptions);
  const chunks = clipChunksToRange(rawChunks, range.startSec, range.endSec);
  store.set({ chunks, selectedChunkId: chunks[0]?.id ?? null });
  log(`Generated ${chunks.length} caption chunk(s).`, "success");
}

function updateChunk(id, patch) {
  store.set((s) => ({
    chunks: s.chunks.map((c) => (c.id === id ? { ...c, ...patch } : c)),
  }));
}

function chunkOptionRow(label, key, opts) {
  const { chunkOptions } = store.getState();
  return el("label", { class: "field field-inline" }, [
    el("span", { class: "field-label", text: label }),
    numberInput(chunkOptions[key], (value) => store.set({ chunkOptions: { ...store.getState().chunkOptions, [key]: value } }), opts),
  ]);
}

function chunkRow(chunk, onChange) {
  const isSelected = store.getState().selectedChunkId === chunk.id;
  const textArea = el("textarea", { class: "chunk-text", rows: "2" });
  textArea.value = chunk.text;
  textArea.addEventListener("input", () => {
    updateChunk(chunk.id, { text: textArea.value, words: chunk.words });
    onChange();
  });

  const recomputeKeywordsBtn = el("button", {
    class: "btn-mini",
    text: "Re-detect keywords",
    onClick: () => {
      const keywords = pickEmphasisWords(chunk.words, { maxKeywords: store.getState().chunkOptions.maxKeywords });
      updateChunk(chunk.id, { keywords });
      onChange();
    },
  });

  const emphasisToggle = checkboxInput(chunk.emphasisOn, (checked) => {
    updateChunk(chunk.id, { emphasisOn: checked });
    onChange();
  });

  const includeToggle = checkboxInput(chunk.included, (checked) => {
    updateChunk(chunk.id, { included: checked });
    onChange();
  });

  return el(
    "div",
    {
      class: `chunk-row${isSelected ? " chunk-row-selected" : ""}${chunk.included ? "" : " chunk-row-excluded"}`,
      onClick: () => {
        store.set({ selectedChunkId: chunk.id });
        onChange();
      },
    },
    [
      el("div", { class: "chunk-time", text: `${chunk.startSec.toFixed(2)}s – ${chunk.endSec.toFixed(2)}s` }),
      textArea,
      el("div", { class: "chunk-meta" }, [
        el("span", { class: "keyword-badges", text: chunk.keywords.length ? `Emphasis: ${chunk.keywords.join(", ")}` : "No emphasis detected" }),
        recomputeKeywordsBtn,
        el("label", { class: "field-inline" }, [emphasisToggle, el("span", { text: "Emphasis on" })]),
        el("label", { class: "field-inline" }, [includeToggle, el("span", { text: "Include" })]),
      ]),
    ]
  );
}

export function renderChunkListPanel(onChange) {
  const state = store.getState();

  const regenBtn = el("button", {
    class: "btn btn-primary",
    text: "Regenerate captions",
    onClick: () => {
      regenerate();
      onChange();
    },
  });

  const list = el(
    "div",
    { class: "chunk-list" },
    state.chunks.length
      ? state.chunks.map((c) => chunkRow(c, onChange))
      : [el("div", { class: "status-line", text: "No caption chunks yet — regenerate to create them." })]
  );

  return el("section", { class: "panel" }, [
    el("h2", { text: "3. Split into timed caption chunks" }),
    el("div", { class: "options-grid" }, [
      chunkOptionRow("Max chars/chunk", "maxChars", { min: 8, max: 80 }),
      chunkOptionRow("Max words/chunk", "maxWords", { min: 1, max: 20 }),
      chunkOptionRow("Max duration (s)", "maxDurationSec", { min: 0.5, max: 10, step: 0.1 }),
      chunkOptionRow("Min duration (s)", "minDurationSec", { min: 0.2, max: 5, step: 0.1 }),
      chunkOptionRow("Pause gap (s)", "pauseGapSec", { min: 0.1, max: 2, step: 0.05 }),
      chunkOptionRow("Emphasis words/chunk", "maxKeywords", { min: 0, max: 5 }),
    ]),
    el("div", { class: "row" }, [regenBtn]),
    list,
  ]);
}
