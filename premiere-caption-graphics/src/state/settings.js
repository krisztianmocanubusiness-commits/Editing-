/**
 * Local extension settings — currently just the "active template" (a
 * .mogrt path + the contract it was inspected against). Backed by the
 * panel webview's `localStorage` where available so it survives closing
 * and reopening the panel, with an in-memory fallback (session-only) if
 * `localStorage` isn't available in this UXP host version — this module
 * has never been confirmed against a live UXP panel, so it degrades
 * instead of throwing if the assumption is wrong. See docs/TEMPLATE_INSPECTOR.md.
 */

const STORAGE_KEY = "captionStudio.activeTemplate.v1";

function hasLocalStorage() {
  try {
    return typeof localStorage !== "undefined" && localStorage !== null;
  } catch {
    return false;
  }
}

// Session-only fallback, used when localStorage throws or isn't defined.
let memoryFallback = null;

/**
 * @returns {{ path: string, contractId: string|null, compliant: boolean, savedAt: string }|null}
 */
export function loadActiveTemplate() {
  if (!hasLocalStorage()) return memoryFallback;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return memoryFallback;
  }
}

/**
 * @param {{ path: string, contractId: string|null, compliant?: boolean }} template
 * @returns {{ ok: true, persisted: boolean, value: object, error?: string }}
 */
export function saveActiveTemplate(template) {
  const value = {
    path: template.path,
    contractId: template.contractId ?? null,
    compliant: !!template.compliant,
    savedAt: new Date().toISOString(),
  };

  memoryFallback = value;
  if (!hasLocalStorage()) {
    return { ok: true, persisted: false, value };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    return { ok: true, persisted: true, value };
  } catch (err) {
    return { ok: true, persisted: false, value, error: String(err) };
  }
}

export function clearActiveTemplate() {
  memoryFallback = null;
  if (!hasLocalStorage()) return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing more we can do; memoryFallback is already cleared.
  }
}
