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

// Default hard timeout for any single Promise-like host value this codebase
// awaits, in milliseconds. Confirmed reproducible failure mode this guards
// against: the Diagnostic Inspector's deep host-object probe (added in
// commit 3371e29) hung indefinitely on a real Premiere Pro 26.3 host —
// something in the probed object graph is Promise-like (has a `.then`) but
// never settles, so a bare `await` on it blocks forever. 400ms is generous
// for a real host round-trip but short enough that even a fully-hung probe
// finishes within a bounded total time (see src/ppro/deepProbe.js's
// createScanBudget for the overall-scan-level bound on top of this
// per-call one).
const DEFAULT_TIMEOUT_MS = 400;

/**
 * Race a Promise-like value against a hard timeout. Never leaves the
 * timer running past settlement, and — critically — never lets the
 * original (possibly still-pending-forever) promise's eventual
 * settlement do anything once this has already timed out or settled;
 * this function's own returned promise only ever settles once.
 *
 * Note: this can't cancel whatever host-side work produced the original
 * promise (JS promises aren't cancellable) — it only stops *this call site*
 * from waiting on it past `ms`. The abandoned original promise, if it does
 * eventually settle, is simply ignored.
 *
 * @param {*} promiseLike
 * @param {number} ms
 * @param {Object} [meta] Extra fields merged onto the timeout Error (e.g. `{ label }`).
 */
export function withTimeout(promiseLike, ms, meta = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const err = new Error(`timed out after ${ms}ms`);
      err.isTimeout = true;
      Object.assign(err, meta);
      reject(err);
    }, ms);
    Promise.resolve(promiseLike).then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * Resolve a possibly-Promise-like host value with a hard timeout, reporting
 * exactly what happened: resolved, rejected, or timed out. Never throws,
 * never waits past `opts.timeoutMs`. This is the one place a raw,
 * possibly-unresolved-forever host value should be normalized before any
 * string method (`.trim()`, `.toLowerCase()`, etc.) or classification logic
 * runs on it — calling those directly on an unresolved Promise is what
 * produced `(matchName || "").trim is not a function`; awaiting one
 * without a timeout is what produced the Diagnostic Inspector hanging
 * indefinitely (see docs/MOGRT_DIAGNOSTIC.md for both).
 *
 * @param {*} value
 * @param {{ log?: (message: string, level?: string) => void, label?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, value?: *, timedOut: boolean, error?: Error }>}
 */
export async function resolveHostValueDetailed(value, opts = {}) {
  const { log, label = "value", timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  if (!isPromiseLike(value)) return { ok: true, value, timedOut: false };
  try {
    const resolved = await withTimeout(value, timeoutMs, { label });
    return { ok: true, value: resolved, timedOut: false };
  } catch (err) {
    if (err && err.isTimeout) {
      if (log) log(`${label} timed out after ${timeoutMs}ms — treating as unreadable and moving on`, "warn");
      return { ok: false, timedOut: true, error: err };
    }
    if (log) log(`Couldn't resolve host ${label} (rejected): ${err.message || err}`, "warn");
    return { ok: false, timedOut: false, error: err };
  }
}

/**
 * Await a host-returned value if it's Promise-like, otherwise return it as
 * is — same contract as before, now built on resolveHostValueDetailed() so
 * every caller gets the timeout guard automatically. Returns `fallback` on
 * timeout, rejection, or an `undefined` resolved value.
 *
 * @param {*} value
 * @param {*} fallback
 * @param {{ log?: (message: string, level?: string) => void, label?: string, timeoutMs?: number }} [opts]
 */
export async function resolveHostValue(value, fallback, opts = {}) {
  const result = await resolveHostValueDetailed(value, opts);
  if (!result.ok) return fallback;
  return result.value === undefined ? fallback : result.value;
}

/**
 * Call `fn()`, then resolve whatever it returns if that's Promise-like —
 * i.e. `safe()` + `resolveHostValueDetailed()` combined into one call, for
 * the common case of "call this host getter, it might throw synchronously,
 * return a Promise that rejects, or return a Promise that never settles —
 * either way I just want {ok, value/error/timedOut}". Never throws, never
 * hangs past `opts.timeoutMs`.
 *
 * @param {() => *} fn
 * @param {{ log?: (message: string, level?: string) => void, label?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: boolean, value?: *, error?: Error, timedOut?: boolean }>}
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
  const resolved = await resolveHostValueDetailed(raw, opts);
  if (!resolved.ok) return { ok: false, error: resolved.error, timedOut: resolved.timedOut };
  return { ok: true, value: resolved.value };
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
