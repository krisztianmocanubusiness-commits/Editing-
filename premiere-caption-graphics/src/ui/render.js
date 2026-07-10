import { clear, el } from "./components/dom.js";
import { store } from "../state/store.js";
import { renderSmokeTestPanel } from "./smokeTestPanel.js";
import { renderTemplateInspectorPanel } from "./templateInspectorPanel.js";
import { renderTranscriptPanel } from "./transcriptPanel.js";
import { renderRangePanel } from "./rangePanel.js";
import { renderChunkListPanel } from "./chunkListPanel.js";
import { renderPresetPanel } from "./presetPanel.js";
import { renderApplyPanel } from "./applyPanel.js";
import { isHosted } from "../ppro/client.js";
import { log } from "../util/log.js";

const TAG = "[Caption Graphics Studio]";

let mounted = false;
let firstRenderDone = false;

// The whole panel is re-rendered from scratch on every store change (see
// mountApp() below), so "section mounted" logging only fires on the very
// first render — otherwise every keystroke in a text field would spam the
// console/log with 7 more mount lines.
function mountSection(root, label, renderFn) {
  const node = renderFn(renderAll);
  root.appendChild(node);
  if (!firstRenderDone) {
    const message = `${TAG} section mounted: ${label}`;
    console.log(message);
    log(message, "info");
  }
}

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

  mountSection(root, "0. Host smoke test", renderSmokeTestPanel);
  mountSection(root, "1. Template Inspector", renderTemplateInspectorPanel);
  mountSection(root, "2. Transcript", renderTranscriptPanel);
  mountSection(root, "3. Timeline range & track", renderRangePanel);
  mountSection(root, "4. Split into timed caption chunks", renderChunkListPanel);
  mountSection(root, "5. Style preset", renderPresetPanel);
  mountSection(root, "6. Approve & apply", renderApplyPanel);

  firstRenderDone = true;
}

export function mountApp() {
  if (mounted) return;
  mounted = true;
  console.log(`${TAG} mountApp() starting first render`);
  store.subscribe(renderAll);
  renderAll();
}
