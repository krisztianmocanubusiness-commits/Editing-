import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { parseTranscript } from "../transcript/index.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { selectedClipHasTranscript, transcriptFromClip } from "../ppro/transcriptBridge.js";
import { getPpro } from "../ppro/client.js";

async function importFromFile() {
  try {
    const uxp = getUxp();
    // @ts-ignore - uxp storage typings vary across host versions
    const file = await uxp.storage.localFileSystem.getFileForOpening({
      types: ["srt", "vtt", "txt", "json"],
    });
    if (!file) return;
    const content = await file.read();
    const transcript = parseTranscript(content, file.name);
    store.set({ transcript, transcriptLabel: `${file.name} (${transcript.words.length} words)` });
    log(`Loaded transcript "${file.name}" — ${transcript.words.length} words, format ${transcript.sourceFormat}.`, "success");
  } catch (err) {
    log(`Transcript import failed: ${err.message || err}`, "error");
  }
}

async function importFromClip() {
  try {
    const ppro = getPpro();
    const { project, sequence } = store.getState();
    if (!project || !sequence) {
      log("Open a sequence and select a clip first.", "error");
      return;
    }
    const selection = await sequence.getSelection();
    const items = await selection.getTrackItems();
    if (items.length === 0) {
      log("Select a clip on the timeline first.", "error");
      return;
    }
    const trackItem = items[0];
    const clipProjectItem = ppro.ClipProjectItem.cast(await trackItem.getProjectItem());
    if (!clipProjectItem) {
      log("Selected item isn't a clip with an attachable transcript.", "error");
      return;
    }
    const has = await selectedClipHasTranscript(clipProjectItem);
    if (!has) {
      log("Selected clip has no attached Premiere transcript. Import a file instead.", "error");
      return;
    }
    const transcript = await transcriptFromClip(clipProjectItem, trackItem);
    store.set({ transcript, transcriptLabel: `Clip transcript (${transcript.words.length} words)` });
    log(`Loaded transcript from selected clip — ${transcript.words.length} words.`, "success");
  } catch (err) {
    log(`Reading clip transcript failed: ${err.message || err}`, "error");
  }
}

export function renderTranscriptPanel(onChange) {
  const state = store.getState();

  const clipBtn = el("button", {
    class: "btn",
    text: "From selected clip's transcript",
    disabled: !isHosted() || undefined,
    onClick: async () => {
      await importFromClip();
      onChange();
    },
  });

  const fileBtn = el("button", {
    class: "btn",
    text: "Import SRT / VTT / TXT / JSON…",
    onClick: async () => {
      await importFromFile();
      onChange();
    },
  });

  return el("section", { class: "panel" }, [
    el("h2", { text: "1. Transcript" }),
    el("div", { class: "row" }, [clipBtn, fileBtn]),
    el("div", { class: "status-line", text: state.transcriptLabel }),
  ]);
}
