// Small status/log helper shared by the whole panel. Mirrors the pattern used
// in Adobe's own UXP Premiere sample panels (a scrolling <div> log).

const LOG_SELECTOR = "#log-body";

const CONSOLE_METHOD = { error: "error", warn: "warn", success: "log", info: "log" };

/**
 * Writes to both the panel's on-screen log AND the devtools console (via the
 * UXP Developer Tool's "Console" tab), so a host-side validation pass
 * doesn't require scrolling a tiny panel — every line here also lands in
 * the console for copy/paste into a bug report.
 */
export function log(message, level = "info") {
  const time = new Date().toLocaleTimeString();
  const method = CONSOLE_METHOD[level] || "log";
  // eslint-disable-next-line no-console
  console[method](`[${time}] [${level}] ${message}`);

  const el = document.querySelector(LOG_SELECTOR);
  if (!el) return;
  const line = document.createElement("div");
  line.className = `log-line log-${level}`;
  line.textContent = `${time}  ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

export function clearLog() {
  const el = document.querySelector(LOG_SELECTOR);
  if (el) el.innerHTML = "";
}
