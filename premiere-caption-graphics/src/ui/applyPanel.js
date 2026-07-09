import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { applyCaptionsToTimeline } from "../ppro/applyCaptions.js";
import { isHosted } from "../ppro/client.js";
import { withActiveTemplateFallback } from "../presets/effectiveMogrt.js";

const NO_TEMPLATE_MESSAGE =
  'No .mogrt to apply: this preset has no template of its own, and no active template is saved. ' +
  'Open "1. Template Inspector" above, inspect a compliant .mogrt, and click "Save as active template" — ' +
  'or choose a .mogrt directly on this preset in "5. Style preset" → "Choose .mogrt…".';

async function apply() {
  const { project, sequence, chunks, activePreset, videoTrackIndex, activeTemplate } = store.getState();

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

  const effectivePreset = withActiveTemplateFallback(activePreset, activeTemplate);
  if (!effectivePreset.mogrt.path) {
    log(NO_TEMPLATE_MESSAGE, "error");
    return;
  }

  const usingActiveTemplate = !activePreset.mogrt.path && effectivePreset.mogrt.path === activeTemplate?.path;
  log(
    usingActiveTemplate
      ? `Using active template: ${effectivePreset.mogrt.path}`
      : `Using this preset's own template: ${effectivePreset.mogrt.path}`,
    "info"
  );

  store.set({ applying: true });
  log(`Applying ${included.length} caption graphic(s) to V${videoTrackIndex + 1}…`, "info");

  try {
    const results = await applyCaptionsToTimeline(project, sequence, included, effectivePreset, videoTrackIndex);
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
  const effectivePreset = withActiveTemplateFallback(state.activePreset, state.activeTemplate);
  const hasTemplate = Boolean(effectivePreset.mogrt.path);

  const applyBtn = el("button", {
    class: "btn btn-primary btn-large",
    text: state.applying ? "Applying…" : `Apply ${includedCount} caption graphic(s) to timeline`,
    disabled: state.applying || includedCount === 0 || !hasTemplate || undefined,
    onClick: async () => {
      await apply();
      onChange();
    },
  });

  const templateStatus = hasTemplate
    ? el("div", { class: "status-line", text: `Will use: ${effectivePreset.mogrt.path}` })
    : el("div", { class: "status-line log-error", text: NO_TEMPLATE_MESSAGE });

  return el("section", { class: "panel panel-apply" }, [
    el("h2", { text: "6. Approve & apply" }),
    el("p", { class: "hint", text: "Review the chunks and preview above, then apply. Nothing touches the timeline until you click this." }),
    templateStatus,
    el("div", { class: "row" }, [applyBtn]),
  ]);
}
