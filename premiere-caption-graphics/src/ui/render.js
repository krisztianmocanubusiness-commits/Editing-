import { clear, el } from "./components/dom.js";
import { store } from "../state/store.js";
import { renderSmokeTestPanel } from "./smokeTestPanel.js";
import { renderTranscriptPanel } from "./transcriptPanel.js";
import { renderRangePanel } from "./rangePanel.js";
import { renderChunkListPanel } from "./chunkListPanel.js";
import { renderPresetPanel } from "./presetPanel.js";
import { renderApplyPanel } from "./applyPanel.js";
import { isHosted } from "../ppro/client.js";

let mounted = false;

function renderAll() {
  const root = document.querySelector("#app");
  if (!root) return;
  clear(root);

  if (!isHosted()) {
    root.appendChild(
      el("div", { class: "banner banner-warn" }, [
        "Not running inside Premiere Pro's UXP host — timeline actions are disabled. " +
          "Load this panel via the UXP Developer Tool against a running Premiere Pro to use it fully.",
      ])
    );
  }

  root.appendChild(renderSmokeTestPanel(renderAll));
  root.appendChild(renderTranscriptPanel(renderAll));
  root.appendChild(renderRangePanel(renderAll));
  root.appendChild(renderChunkListPanel(renderAll));
  root.appendChild(renderPresetPanel(renderAll));
  root.appendChild(renderApplyPanel(renderAll));
}

export function mountApp() {
  if (mounted) return;
  mounted = true;
  store.subscribe(renderAll);
  renderAll();
}
