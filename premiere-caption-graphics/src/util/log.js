// Small status/log helper shared by the whole panel. Mirrors the pattern used
// in Adobe's own UXP Premiere sample panels (a scrolling <div> log).
import { getUxp } from "../ppro/client.js";

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

/**
 * Copies the full on-screen log (every line currently in #log-body, not
 * just what's scrolled into view) to the system clipboard. Tries three
 * strategies in order, since it's not certain in advance which one actually
 * works inside Premiere's UXP host webview: the UXP clipboard module
 * (declared in manifest.json's requiredPermissions — the documented way to
 * do this from a UXP panel), the browser Clipboard API (works in some UXP
 * webview versions), and finally a hidden-textarea + execCommand("copy")
 * fallback (the old but broadly-compatible approach). Never throws.
 *
 * @returns {Promise<{ ok: boolean, method?: string, error?: string }>}
 */
export async function copyLogToClipboard() {
  const el = document.querySelector(LOG_SELECTOR);
  if (!el) return { ok: false, error: "log panel not found" };
  const text = [...el.querySelectorAll(".log-line")].map((line) => line.textContent).join("\n");
  if (!text) return { ok: false, error: "log is empty" };

  try {
    const uxp = getUxp();
    if (uxp && uxp.clipboard && typeof uxp.clipboard.copyText === "function") {
      uxp.clipboard.copyText(text);
      return { ok: true, method: "uxp.clipboard.copyText" };
    }
  } catch {
    // Not running in a UXP host, or the clipboard module isn't available — try the next strategy.
  }

  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      await navigator.clipboard.writeText(text);
      return { ok: true, method: "navigator.clipboard.writeText" };
    }
  } catch {
    // Fall through to the execCommand fallback.
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const copied = document.execCommand("copy");
    document.body.removeChild(textarea);
    if (copied) return { ok: true, method: "execCommand" };
  } catch {
    // All strategies exhausted.
  }

  return { ok: false, error: "no clipboard method succeeded in this environment" };
}
