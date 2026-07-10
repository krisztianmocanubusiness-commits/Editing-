/**
 * Shared "safely call the host API and report what actually happened"
 * helpers, plus the component/param discovery walk. Originally written for
 * src/ppro/smokeTest.js; extracted here so src/ppro/templateInspector.js can
 * reuse the exact same discovery logic instead of re-implementing it (and
 * risking the two drifting apart).
 */

const MAX_COMPONENT_SCAN = 64;
const MAX_PARAM_SCAN = 64;

export function safe(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function safeAsync(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function describeValue(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Is this value awaitable (a real Promise, or a thenable)? Some UXP host
 * getters (confirmed: `TrackItem.matchName` on Premiere Pro 26.3, which
 * returned a live Promise instead of a string — see
 * docs/MOGRT_DIAGNOSTIC.md) return a Promise from what looks like a plain
 * property, not just from an explicit async method. Every host-value read
 * in this codebase should treat "might be a Promise" as the default
 * assumption, not something only method calls need.
 */
export function isPromiseLike(value) {
  return !!value && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

/**
 * Await a host-returned value if it's Promise-like, otherwise return it as
 * is. Never throws: a rejected promise (or a synchronous throw while
 * awaiting a thenable's `.then`) is caught and reported via `opts.log` (if
 * given), returning `fallback` instead. This is the one place a raw,
 * possibly-unresolved host value should be normalized before any string
 * method (`.trim()`, `.toLowerCase()`, etc.) or classification logic runs
 * on it — calling those directly on an unresolved Promise is exactly what
 * produced `(matchName || "").trim is not a function` in
 * src/ppro/diagnostics.js.
 *
 * @param {*} value
 * @param {*} fallback
 * @param {{ log?: (message: string, level?: string) => void, label?: string }} [opts]
 */
export async function resolveHostValue(value, fallback, opts = {}) {
  const { log, label = "value" } = opts;
  try {
    const resolved = isPromiseLike(value) ? await value : value;
    return resolved === undefined ? fallback : resolved;
  } catch (err) {
    if (log) log(`Couldn't resolve host ${label} (rejected): ${err.message || err}`, "warn");
    return fallback;
  }
}

/**
 * Call `fn()`, then resolve whatever it returns if that's Promise-like —
 * i.e. `safe()` + `resolveHostValue()` combined into one call, for the
 * common case of "call this host getter, it might throw synchronously OR
 * return a Promise that rejects, either way I just want {ok, value/error}".
 * Never throws.
 *
 * @param {() => *} fn
 * @param {{ log?: (message: string, level?: string) => void, label?: string }} [opts]
 * @returns {Promise<{ ok: boolean, value?: *, error?: Error }>}
 */
export async function safeResolve(fn, opts = {}) {
  const { log, label = "value" } = opts;
  let raw;
  try {
    raw = fn();
  } catch (err) {
    if (log) log(`${label} threw synchronously: ${err.message || err}`, "warn");
    return { ok: false, error: err };
  }
  try {
    const value = isPromiseLike(raw) ? await raw : raw;
    return { ok: true, value };
  } catch (err) {
    if (log) log(`${label} rejected: ${err.message || err}`, "warn");
    return { ok: false, error: err };
  }
}

/**
 * Normalize any resolved host value to a string or null — never returns a
 * raw object (a Promise that slipped through, or any other non-string
 * value) for callers that are about to call string methods on the result.
 * If the value is already a string, returned as is; otherwise converted via
 * `String()`, guarded in case that itself throws.
 *
 * @param {*} value
 */
export function toSafeString(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const result = safe(() => String(value));
  return result.ok ? result.value : null;
}

/**
 * Walk every component/param on a track item and log what's actually
 * there — names, best-effort "type", and current value where readable.
 * Scan bounds are defensive: no explicit count method appears in Adobe's
 * public sample (see mogrt.js findExposedParam for the same caveat).
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @returns {Promise<{ componentIndex: number, paramIndex: number, name: string, type: string, param: object, component: object }[]>}
 */
export async function dumpComponentChain(trackItem, log) {
  log("Reading component chain…", "info");
  const chainResult = await safeAsync(() => trackItem.getComponentChain());
  if (!chainResult.ok) {
    log(`✗ getComponentChain() threw: ${chainResult.error.message || chainResult.error}`, "error");
    return [];
  }
  const chain = chainResult.value;
  if (!chain) {
    log("✗ getComponentChain() returned nothing.", "error");
    return [];
  }

  const discovered = [];
  for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
    const componentResult = safe(() => chain.getComponentAtIndex(ci));
    if (!componentResult.ok) {
      log(`Component scan stopped at index ${ci}: ${componentResult.error.message || componentResult.error}`, "info");
      break;
    }
    const component = componentResult.value;
    if (!component) {
      log(`Component scan stopped at index ${ci}: no component returned.`, "info");
      break;
    }

    const name = safe(() => component.displayName).value ?? safe(() => component.matchName).value ?? `Component[${ci}]`;
    log(`Component ${ci}: "${name}"`, "info");

    for (let pi = 0; pi < MAX_PARAM_SCAN; pi++) {
      const paramResult = safe(() => component.getParam(pi));
      if (!paramResult.ok || !paramResult.value) break;
      const param = paramResult.value;

      const paramName = safe(() => param.displayName).value ?? `Param[${pi}]`;
      const paramType = safe(() => param.type).value ?? safe(() => param.paramType).value ?? "unknown";
      const startValue = await safeAsync(() => param.getStartValue());
      const currentValueStr = startValue.ok ? describeValue(startValue.value) : `unreadable (${startValue.error.message || startValue.error})`;

      log(`  Param ${pi}: "${paramName}" — type=${paramType}, currentValue=${currentValueStr}`, "info");
      discovered.push({ componentIndex: ci, paramIndex: pi, name: paramName, type: paramType, param, component });
    }
  }

  log(`Component/param scan complete: ${discovered.length} exposed param(s) found.`, discovered.length ? "success" : "warn");
  return discovered;
}
