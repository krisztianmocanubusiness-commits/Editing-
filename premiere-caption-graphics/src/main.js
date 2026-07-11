// Premiere Pro UXP panel entrypoint.
//
// IMPORTANT: this file is authored as an ES module (like the rest of
// src/), but it must never be loaded directly via <script type="module">
// in index.html. Confirmed root cause (Premiere Pro 26.3): the UXP panel
// webview did not execute a multi-file `<script type="module">` graph at
// all — no console output, no thrown error, nothing — just a static
// header and an empty log box, because src/main.js never ran. UXP's own
// documented module mechanism is `require()` (see src/ppro/client.js:
// `require("premierepro")` / `require("uxp")`, matching Adobe's own
// uxp-premiere-pro-samples reference panel), not browser ES modules.
//
// The fix: `npm run build` (esbuild) bundles this file and everything it
// imports into one plain script, dist/main.js, with no import/export left
// in it anywhere — that's what index.html actually loads now, via a plain
// <script src="dist/main.js"></script> (no type="module"). The only two
// real require() calls in the whole app (premierepro, uxp) are marked
// external in the build and pass through untouched, since those are
// genuine UXP host modules, not files this bundle can inline.
//
// See test/entrypoint.test.js for the static check that keeps
// type="module" from being reintroduced into index.html.

import { mountApp } from "./ui/render.js";
import { getUxp } from "./ppro/client.js";
import { log, clearLog, copyLogToClipboard } from "./util/log.js";

const TAG = "[Caption Graphics Studio]";

// Everything below is the first runtime code this bundle executes. (ES
// module `import` declarations above are hoisted by the language spec and
// always run first regardless of position in the file — that's not
// something a try/catch here can intercept. The `npm run build` step
// itself is what catches a structural failure in the imported module
// graph, since esbuild parses and compiles every file it bundles before
// dist/main.js can even be produced.)
console.log(`${TAG} entry script started`);
logHostInfo();

try {
  mountApp();
  console.log(`${TAG} mountApp() completed without throwing`);
} catch (err) {
  console.error(`${TAG} startup failed:`, err);
  renderStartupError(err);
}

wireLogPanelControls();

// The Log panel (index.html's static #log-body/#copy-log-btn/#clear-log-btn)
// lives outside #app and is never touched by render.js's re-renders, so it
// only needs wiring once here — not on every store change.
function wireLogPanelControls() {
  const copyBtn = document.querySelector("#copy-log-btn");
  if (copyBtn) {
    copyBtn.addEventListener("click", async () => {
      const result = await copyLogToClipboard();
      log(result.ok ? `Log copied to clipboard (via ${result.method}).` : `Couldn't copy the log: ${result.error}`, result.ok ? "success" : "error");
    });
  }
  const clearBtn = document.querySelector("#clear-log-btn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearLog();
      log("Log cleared.", "info");
    });
  }
}

function logHostInfo() {
  try {
    const uxp = getUxp();
    const uxpVersion = uxp?.versions?.uxp ?? "unknown";
    const hostName = uxp?.host?.name ?? "unknown";
    const hostVersion = uxp?.host?.version ?? "unknown";
    console.log(`${TAG} UXP version: ${uxpVersion}`);
    console.log(`${TAG} Host: ${hostName} ${hostVersion}`);
  } catch (err) {
    console.warn(`${TAG} Could not read UXP/host version info (uxp module unavailable — not running in a UXP host?): ${err.message || err}`);
  }
}

function renderStartupError(err) {
  try {
    const root = document.querySelector("#app") || document.body;
    const box = document.createElement("div");
    box.className = "startup-error";
    const message = err && err.message ? err.message : String(err);
    box.innerHTML =
      `<strong>${escapeHtml(TAG)} failed to start.</strong>` +
      `<div>${escapeHtml(message)}</div>` +
      (err && err.stack ? `<pre>${escapeHtml(err.stack)}</pre>` : "");
    root.prepend(box);
  } catch (renderErr) {
    console.error(`${TAG} could not even render the startup error box:`, renderErr);
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
