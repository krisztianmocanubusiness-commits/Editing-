// Small status/log helper shared by the whole panel. Mirrors the pattern used
// in Adobe's own UXP Premiere sample panels (a scrolling <div> log).

const LOG_SELECTOR = "#log-body";

export function log(message, level = "info") {
  const el = document.querySelector(LOG_SELECTOR);
  if (!el) {
    console.log(`[${level}] ${message}`);
    return;
  }
  const line = document.createElement("div");
  line.className = `log-line log-${level}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `${time}  ${message}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

export function clearLog() {
  const el = document.querySelector(LOG_SELECTOR);
  if (el) el.innerHTML = "";
}
