import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { applyCaptionsToTimeline } from "../ppro/applyCaptions.js";
import { isHosted } from "../ppro/client.js";

async function apply() {
  const { project, sequence, chunks, activePreset, videoTrackIndex } = store.getState();

  if (!isHosted()) {
    log("Not running inside Premiere Pro — nothing to apply.", "error");
    return;
  }
  if (!project || !sequence) {
    log("Read the sequence's in/out range first so the project/sequence are attached.", "error");
    return;
  }
  const included = chunks.filter((c) => c.included);
  if (included.length === 0) {
    log("No included caption chunks to apply. Regenerate captions first.", "error");
    return;
  }
  if (!activePreset.mogrt.path) {
    log("Choose a .mogrt file for this preset first (see mogrt-authoring/README.md).", "error");
    return;
  }

  store.set({ applying: true });
  log(`Applying ${included.length} caption graphic(s) to V${videoTrackIndex + 1}…`, "info");

  try {
    const results = await applyCaptionsToTimeline(project, sequence, included, activePreset, videoTrackIndex);
    const ok = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    for (const r of ok) {
      const warn = r.missingParams?.length ? ` (missing params on this .mogrt: ${r.missingParams.join(", ")})` : "";
      log(`✓ "${r.chunk.text.slice(0, 30)}" @ ${r.chunk.startSec.toFixed(2)}s${warn}`, r.missingParams?.length ? "warn" : "success");
    }
    for (const r of failed) {
      log(`✗ "${r.chunk.text.slice(0, 30)}" @ ${r.chunk.startSec.toFixed(2)}s — ${r.error}`, "error");
    }
    log(`Done: ${ok.length} applied, ${failed.length} failed.`, failed.length ? "warn" : "success");
  } catch (err) {
    log(`Apply failed: ${err.message || err}`, "error");
  } finally {
    store.set({ applying: false });
  }
}

export function renderApplyPanel(onChange) {
  const state = store.getState();
  const includedCount = state.chunks.filter((c) => c.included).length;

  const applyBtn = el("button", {
    class: "btn btn-primary btn-large",
    text: state.applying ? "Applying…" : `Apply ${includedCount} caption graphic(s) to timeline`,
    disabled: state.applying || includedCount === 0 || undefined,
    onClick: async () => {
      await apply();
      onChange();
    },
  });

  return el("section", { class: "panel panel-apply" }, [
    el("h2", { text: "5. Approve & apply" }),
    el("p", { class: "hint", text: "Review the chunks and preview above, then apply. Nothing touches the timeline until you click this." }),
    el("div", { class: "row" }, [applyBtn]),
  ]);
}
