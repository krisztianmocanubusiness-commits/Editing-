import { el, selectInput } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { requireActiveProjectAndSequence, getSelectedRangeSeconds, listVideoTracks } from "../ppro/timelineRange.js";

function formatSec(s) {
  const mm = Math.floor(s / 60);
  const ss = (s % 60).toFixed(2);
  return `${mm}:${ss.padStart(5, "0")}`;
}

async function refreshFromHost() {
  const { project, sequence } = await requireActiveProjectAndSequence();
  const range = await getSelectedRangeSeconds(sequence);
  const videoTracks = await listVideoTracks(sequence);
  store.set({
    project,
    sequence,
    range,
    videoTracks,
    videoTrackIndex: videoTracks.some((t) => t.index === store.getState().videoTrackIndex)
      ? store.getState().videoTrackIndex
      : videoTracks[videoTracks.length - 1]?.index ?? 0,
  });
  log(`Timeline range: ${formatSec(range.startSec)} – ${formatSec(range.endSec)}.`, "info");
}

export function renderRangePanel(onChange) {
  const state = store.getState();

  const refreshBtn = el("button", {
    class: "btn",
    text: "Read sequence in/out",
    onClick: async () => {
      try {
        await refreshFromHost();
      } catch (err) {
        log(`${err.message || err}`, "error");
      }
      onChange();
    },
  });

  const trackOptions = state.videoTracks.length
    ? state.videoTracks.map((t) => ({ value: String(t.index), label: t.name }))
    : [{ value: "1", label: "V2 (default)" }];

  const trackSelect = selectInput(String(state.videoTrackIndex), trackOptions, (value) => {
    store.set({ videoTrackIndex: Number(value) });
  });

  return el("section", { class: "panel" }, [
    el("h2", { text: "2. Timeline range & track" }),
    el("div", { class: "row" }, [refreshBtn]),
    el("div", { class: "status-line" }, [
      `Range: ${formatSec(state.range.startSec)} – ${formatSec(state.range.endSec)}`,
    ]),
    el("div", { class: "row" }, [
      el("span", { class: "field-label", text: "Target video track (empty track recommended):" }),
      trackSelect,
    ]),
  ]);
}
