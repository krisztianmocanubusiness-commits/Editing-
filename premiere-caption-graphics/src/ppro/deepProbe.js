/**
 * Generic, feature-detected "what is this host object, really" prober.
 * Built because the Diagnostic Inspector's first pass found the real
 * component chain on a Premiere-native MOGRT (`AE.ADBE Opacity`,
 * `AE.ADBE Motion`, `AE.ADBE Graphic Group`) but every one of its 20 params
 * reported `type: "unknown"` and `value: {}` — because `describeValue()`
 * uses `JSON.stringify`, which only sees *enumerable own* properties, and
 * UXP's native-bridge objects almost certainly expose their real data
 * through non-enumerable getters/methods instead. This module inspects an
 * object's actual shape (`Object.keys`, `Object.getOwnPropertyNames`,
 * prototype chain, constructor) and safely calls its zero-argument,
 * getter-shaped methods, so a `{}`-looking value can still tell us
 * something.
 *
 * SAFETY, after this probe was found to hang indefinitely on a real host
 * (see docs/MOGRT_DIAGNOSTIC.md): every function here is bounded on THREE
 * independent axes, any one of which is enough to guarantee termination —
 *   1. Per-call timeout (introspect.js's resolveHostValueDetailed/
 *      safeResolve) — no single Promise-like host value is ever awaited
 *      for longer than a few hundred ms, even if it never settles.
 *   2. A shared scan budget (createScanBudget()) — a wall-clock deadline
 *      (and/or a cooperative cancel flag) checked before every single
 *      field read, method call, component, and param, so total scan time
 *      is bounded regardless of how much there is to probe.
 *   3. Structural caps (MAX_PROTO_DEPTH, MAX_OWN_PROPERTY_NAMES,
 *      MAX_METHOD_CALLS, MAX_ARRAY_SAMPLE) plus WeakSet-based cycle
 *      detection — bounds the *amount* of work even if timeouts/budget
 *      were somehow bypassed.
 * Every function here is also careful never to call anything that looks
 * state-mutating (see DANGEROUS_NAME_FRAGMENTS) — this is a read-only
 * exploration tool, not a way to script Premiere.
 */
import { safe, isPromiseLike, resolveHostValueDetailed, safeResolve } from "./introspect.js";

const MAX_PROTO_DEPTH = 6;
const MAX_OWN_PROPERTY_NAMES = 300;
const MAX_METHOD_CALLS = 80;
const MAX_ARRAY_SAMPLE = 20;
const MAX_STRING_PREVIEW = 500;

// Per-call timeout for a single field read or method call within the deep
// probe. Deliberately shorter than introspect.js's own DEFAULT_TIMEOUT_MS
// default isn't overridden here — this constant exists so probe call sites
// can be grepped/tuned independently of the rest of the codebase's timeout.
export const PROBE_CALL_TIMEOUT_MS = 400;

// Total wall-clock budget for one whole deep-probe run (all objects, all
// fields, all methods combined) — see createScanBudget(). Suggested range
// from the task that added this: 10-15s; 12s picked as a middle value.
export const DEFAULT_SCAN_BUDGET_MS = 12000;

/**
 * A shared, mutable time/cancellation budget threaded through every probing
 * function below. `isExpired()` is checked before starting each unit of
 * work (each field, each method, each component, each param) — the moment
 * it returns true, all remaining work in the current scan is skipped
 * (recorded as skipped, not silently dropped) rather than attempted.
 *
 * @param {{ totalMs?: number, cancelToken?: { cancelled: boolean } | null }} [opts]
 */
export function createScanBudget({ totalMs = DEFAULT_SCAN_BUDGET_MS, cancelToken = null } = {}) {
  const deadline = Date.now() + totalMs;
  return {
    cancelToken,
    isExpired() {
      if (cancelToken && cancelToken.cancelled) return true;
      return Date.now() >= deadline;
    },
    reason() {
      if (cancelToken && cancelToken.cancelled) return "cancelled";
      if (Date.now() >= deadline) return "time-budget-exceeded";
      return null;
    },
  };
}

/**
 * Every own + inherited (bounded depth) property name, deduped, with a note
 * of which prototype level each came from. Guards against a cyclic
 * prototype chain (a WeakSet of already-visited prototypes; essentially
 * impossible in real V8, but explicitly guarded per the task that asked
 * for it) on top of the existing depth cap.
 */
function walkPrototypeChain(obj) {
  const seen = new Map(); // name -> first depth seen at
  const visitedPrototypes = new WeakSet();
  let current = obj;
  let depth = 0;
  while (current !== null && current !== undefined && depth <= MAX_PROTO_DEPTH) {
    if (typeof current === "object" || typeof current === "function") {
      if (visitedPrototypes.has(current)) break;
      visitedPrototypes.add(current);
    }
    const names = safe(() => Object.getOwnPropertyNames(current)).value ?? [];
    for (const name of names) {
      if (!seen.has(name)) seen.set(name, depth);
    }
    current = safe(() => Object.getPrototypeOf(current)).value ?? null;
    if (current === Object.prototype || current === Function.prototype) break;
    depth += 1;
  }
  return seen;
}

// Method names this prober will actually CALL (not just list) must look
// like a plain read-only getter by name AND take no required arguments
// (Function.prototype.length === 0). Anything matching one of these
// fragments is skipped regardless, even if it otherwise looks safe, since
// these verbs suggest a side effect — a host operation, a UI action, a
// scan/refresh, an import/export, or a mutation. Broadened after the task
// that asked for stricter auto-invocation to name every category it called
// out explicitly, rather than just the original mutation-verb set.
const DANGEROUS_NAME_FRAGMENTS = [
  // mutation / lifecycle
  "set", "remove", "delete", "clear", "close", "dispose", "destroy",
  "create", "add", "insert", "execute", "select", "update", "write",
  "save", "move", "copy", "rename", "reset", "undo", "redo",
  "import", "export", "load", "unload", "open", "lock", "unlock",
  // host operations / UI actions
  "scan", "refresh", "reload", "sync", "render", "play", "record",
  "show", "hide", "focus", "activate", "connect", "disconnect",
  "convert", "build", "generate", "process", "run", "start", "stop",
  "pause", "seek", "navigate", "upload", "download", "fetch", "request",
  "trigger", "invoke", "extract", "print", "wait", "sleep",
];

// Belt-and-suspenders allowlist: the ONLY name shapes this prober will ever
// consider calling, checked BEFORE the dangerous-fragment blocklist above
// (task's "use an explicit allowlist first"). Everything else is listed
// but never invoked, full stop — no amount of looking safe overrides this.
const CALLABLE_NAME_PATTERN = /^(get|is|has)[A-Z0-9]/;
const CALLABLE_EXACT_NAMES = new Set(["toString", "valueOf"]);

// CONFIRMED real-host bug (see docs/MOGRT_DIAGNOSTIC.md): Premiere's
// host-proxy functions report `function.length` (this prober's only
// "needs arguments?" signal) as 0 even when a real argument IS required —
// `getValueAtTime()` and `getParam()` both do this. That made the probe
// auto-call `getValueAtTime()` on every param with no time argument,
// which reliably timed out (400ms x dozens of calls), burning almost the
// entire scan budget before a single AE.ADBE Text param could be reached.
// `argCount === 0` can therefore no longer be trusted as sufficient
// evidence of safety — these exact names (and name patterns strongly
// suggesting a required time/keyframe argument) are excluded from
// auto-invocation UNCONDITIONALLY, regardless of what argCount claims.
const NEVER_AUTO_CALL_EXACT_NAMES = new Set([
  "getParam",
  "getValueAtTime",
  "findNearestKeyframe",
  "findNextKeyframe",
  "findPreviousKeyframe",
  "createSetValueAction",
]);
const NEVER_AUTO_CALL_NAME_PATTERNS = [/AtTime$/i, /Keyframe/i, /^create/i];

function isSafeToCallByName(name) {
  if (NEVER_AUTO_CALL_EXACT_NAMES.has(name)) return false;
  if (NEVER_AUTO_CALL_NAME_PATTERNS.some((re) => re.test(name))) return false;
  if (!CALLABLE_NAME_PATTERN.test(name) && !CALLABLE_EXACT_NAMES.has(name)) return false;
  const lower = name.toLowerCase();
  return !DANGEROUS_NAME_FRAGMENTS.some((frag) => lower.includes(frag));
}

/**
 * Best-effort classification of a resolved (non-Promise) value's "kind",
 * purely from its own readable shallow field names — a heuristic, not a
 * host-confirmed taxonomy. Anything not matching a recognizable shape falls
 * back to "other-host-object" rather than guessing further.
 */
function inferValueKind(value, shallowFields, propNames) {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  const t = typeof value;
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  if (t === "function") return "function";
  if (Array.isArray(value)) return "array";

  const lowerProps = propNames.map((p) => p.toLowerCase());
  const has = (...names) => names.some((n) => lowerProps.includes(n));
  if (has("x", "y") || has("horiz", "vert")) return "point-like";
  if (has("red", "green", "blue") || (has("r") && has("g") && has("b"))) return "color-like";
  if (has("text") && (has("fontsize") || has("font"))) return "text-document-like";
  // NOTE: this only ever READS the `.length` field's numeric value for
  // classification — it never iterates/indexes the object by it, so an
  // object reporting a huge (even fake) length can't cause this to loop or
  // hang.
  if (typeof shallowFields.length === "number" || has("numitems")) return "collection-like";
  if (Object.keys(shallowFields).length === 1 && typeof Object.values(shallowFields)[0] === "number") return "ratio-or-enum-like";
  return "other-host-object";
}

/**
 * Summarize any resolved (already-awaited, non-Promise) host value into a
 * plain, JSON-safe, best-effort-typed description — never the raw value
 * itself for object types, so this is always safe to JSON.stringify and
 * never holds a live host reference past the call that produced it.
 *
 * Cycle-safe: `seen` is a WeakSet of object references already visited in
 * the current summarization tree (only ever grows during one top-level
 * call — external callers should never pass their own `seen`). The only
 * recursive path is array-sampling, so that's the only place a cycle could
 * otherwise cause infinite recursion (e.g. an array containing itself).
 *
 * @param {*} value
 * @param {WeakSet<object>} [seen]
 * @returns {Object}
 */
export function summarizeHostValue(value, seen = new WeakSet()) {
  if (value === null) return { kind: "null" };
  if (value === undefined) return { kind: "undefined" };
  const t = typeof value;

  if (t === "string") {
    return {
      kind: "string",
      length: value.length,
      preview: value.length > MAX_STRING_PREVIEW ? `${value.slice(0, MAX_STRING_PREVIEW)}…` : value,
    };
  }
  if (t === "number" || t === "boolean") return { kind: t, value };
  if (t === "function") return { kind: "function" };

  if (t === "object") {
    if (seen.has(value)) {
      return { kind: "cyclic-reference", note: "this object was already visited earlier in the same value tree" };
    }
    seen.add(value);
  }

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      sample: value.slice(0, MAX_ARRAY_SAMPLE).map((v) => summarizeHostValue(v, seen)),
    };
  }

  if (t === "object") {
    const ownPropertyNames = (safe(() => Object.getOwnPropertyNames(value)).value ?? []).slice(0, MAX_OWN_PROPERTY_NAMES);
    const ownKeys = safe(() => Object.keys(value)).value ?? [];
    const constructorName = safe(() => value.constructor?.name).value ?? null;

    // Shallow only — reads primitive-typed own properties without
    // recursing into nested objects, so this loop's cost is bounded by
    // MAX_OWN_PROPERTY_NAMES regardless of how deep or wide the value's
    // own object graph is.
    const shallowFields = {};
    for (const name of ownPropertyNames) {
      const r = safe(() => value[name]);
      if (r.ok && (typeof r.value === "string" || typeof r.value === "number" || typeof r.value === "boolean")) {
        shallowFields[name] = r.value;
      }
    }

    return {
      kind: inferValueKind(value, shallowFields, ownPropertyNames),
      constructorName,
      ownKeys,
      ownPropertyNames,
      shallowPrimitiveFields: shallowFields,
    };
  }

  return { kind: t };
}

/** Compact one-line rendering of a summary, for log lines (the full structured summary goes in the returned/saved JSON instead). */
export function formatSummaryForLog(summary) {
  if (!summary) return "n/a";
  switch (summary.kind) {
    case "null":
    case "undefined":
    case "function":
    case "cyclic-reference":
      return summary.kind;
    case "string":
      return `string(${JSON.stringify(summary.preview)}${summary.length > MAX_STRING_PREVIEW ? "…truncated" : ""})`;
    case "number":
    case "boolean":
      return `${summary.kind}(${summary.value})`;
    case "array":
      return `array[${summary.length}]`;
    default: {
      const fieldPreview = Object.entries(summary.shallowPrimitiveFields || {})
        .slice(0, 6)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      return `${summary.kind}${summary.constructorName ? ` (${summary.constructorName})` : ""}${fieldPreview ? ` {${fieldPreview}}` : ""}`;
    }
  }
}

/**
 * Reads a single field (own or inherited) via a plain property access —
 * `obj[name]` naturally walks the prototype chain and invokes an inherited
 * accessor's getter, so no special access pattern is needed for a
 * prototype-defined property, just the same timeout-guarded read as any
 * own one. Never throws.
 */
async function readField(obj, name, label, log) {
  const raw = safe(() => obj[name]);
  if (!raw.ok) {
    return { readError: String(raw.error.message || raw.error) };
  }
  const wasPromiseLike = isPromiseLike(raw.value);
  const resolved = await resolveHostValueDetailed(raw.value, { log, label: `${label}.${name}`, timeoutMs: PROBE_CALL_TIMEOUT_MS });
  if (!resolved.ok && resolved.timedOut) {
    return { wasPromiseLike, timedOut: true, method: `${label}.${name}`, stage: "field-read" };
  }
  if (!resolved.ok) {
    return { wasPromiseLike, readError: String(resolved.error.message || resolved.error) };
  }
  return { wasPromiseLike, summary: summarizeHostValue(resolved.value) };
}

/**
 * Inspect an object's real shape: own property names, own enumerable keys,
 * prototype-chain property/method names (bounded depth), constructor name,
 * and every field's resolved value/Promise-like flag — for BOTH own
 * enumerable keys (`fields`) AND non-method properties found only on the
 * prototype chain (`inheritedFields`). The latter matters because several
 * confirmed real-host result types (`Keyframe`/`PointKeyframe`, returned by
 * `ComponentParam.getStartValue()`) expose their actual data — `.value`,
 * `.position` — as accessor properties defined on the constructor's
 * prototype, not as own-enumerable properties on the instance, so
 * `Object.keys()`-only enumeration never sees them at all (this is why the
 * probe used to report `value: {}` for these — see
 * docs/MOGRT_DIAGNOSTIC.md). Never throws, never waits on a single field
 * past PROBE_CALL_TIMEOUT_MS, and stops early (marking `truncated: true`)
 * the moment `budget` (if given) expires.
 *
 * @param {*} obj
 * @param {string} label
 * @param {(message: string, level?: string) => void} [log]
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function probeObjectShape(obj, label, log, budget) {
  if (obj === null || obj === undefined) {
    return { label, exists: false };
  }
  if (budget && budget.isExpired()) {
    return { label, exists: true, skipped: true, reason: budget.reason() };
  }

  const constructorName = safe(() => obj.constructor?.name).value ?? null;
  const ownPropertyNames = (safe(() => Object.getOwnPropertyNames(obj)).value ?? []).slice(0, MAX_OWN_PROPERTY_NAMES);
  const ownKeys = safe(() => Object.keys(obj)).value ?? [];

  const protoNames = walkPrototypeChain(obj);
  const prototypeMethodNames = [];
  const prototypeNonMethodNames = [];
  for (const name of protoNames.keys()) {
    if (name === "constructor") continue;
    const isFn = safe(() => typeof obj[name] === "function").value === true;
    (isFn ? prototypeMethodNames : prototypeNonMethodNames).push(name);
  }

  const fields = {};
  let truncated = false;
  for (const name of ownKeys.slice(0, MAX_OWN_PROPERTY_NAMES)) {
    if (budget && budget.isExpired()) {
      truncated = true;
      break;
    }
    fields[name] = await readField(obj, name, label, log);
  }

  // Inherited (prototype-only) non-method properties not already covered
  // above as an own key — e.g. Keyframe.prototype.value.
  const inheritedFields = {};
  if (!truncated) {
    for (const name of prototypeNonMethodNames) {
      if (ownKeys.includes(name)) continue;
      if (budget && budget.isExpired()) {
        truncated = true;
        break;
      }
      inheritedFields[name] = await readField(obj, name, label, log);
    }
  }

  return {
    label,
    exists: true,
    constructorName,
    ownPropertyNames,
    ownKeys,
    prototypeMethodNames,
    prototypeNonMethodNames,
    fields,
    inheritedFields,
    ...(truncated ? { truncated: true, truncatedReason: budget?.reason() ?? null } : {}),
  };
}

/**
 * Enumerate every method on an object's prototype chain (bounded depth) and
 * safely CALL the ones that look like zero-argument, read-only getters by
 * name (see isSafeToCallByName — an explicit allowlist pattern checked
 * before a broad danger-fragment blocklist) — everything else is listed but
 * not invoked, so this can never trigger a state-mutating host call.
 * Bounded to MAX_METHOD_CALLS actual invocations, and stops early
 * (remaining names listed as skipped, not called) the moment `budget` (if
 * given) expires.
 *
 * @param {*} obj
 * @param {string} label
 * @param {(message: string, level?: string) => void} [log]
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function probeSafeMethods(obj, label, log, budget) {
  if (obj === null || obj === undefined) {
    return { label, exists: false, methods: [] };
  }
  if (budget && budget.isExpired()) {
    return { label, exists: true, methods: [], skipped: true, reason: budget.reason() };
  }

  const protoNames = walkPrototypeChain(obj);
  const methodNames = [...protoNames.keys()].filter(
    (name) => name !== "constructor" && safe(() => typeof obj[name] === "function").value === true
  );

  const methods = [];
  let calls = 0;
  for (const name of methodNames) {
    if (budget && budget.isExpired()) {
      methods.push({ name, called: false, reason: budget.reason() });
      continue;
    }
    const argCount = safe(() => obj[name].length).value ?? 0;
    const eligible = argCount === 0 && isSafeToCallByName(name);
    if (!eligible || calls >= MAX_METHOD_CALLS) {
      methods.push({ name, argCount, called: false, reason: calls >= MAX_METHOD_CALLS ? "call-cap-reached" : argCount > 0 ? "needs-arguments" : "name-not-recognized-as-safe-getter" });
      continue;
    }
    calls += 1;
    const result = await safeResolve(() => obj[name](), { log, label: `${label}.${name}()`, timeoutMs: PROBE_CALL_TIMEOUT_MS });
    if (!result.ok && result.timedOut) {
      methods.push({ name, argCount, called: true, timedOut: true, method: `${label}.${name}()`, stage: "method-call" });
      continue;
    }
    methods.push({
      name,
      argCount,
      called: true,
      ok: result.ok,
      resultSummary: result.ok ? summarizeHostValue(result.value) : undefined,
      error: result.ok ? undefined : String(result.error.message || result.error),
    });
  }

  return { label, exists: true, allMethodNames: methodNames, methods };
}

/**
 * Combined shape + safe-method probe for one host object — the single
 * entry point most callers want. See probeObjectShape()/probeSafeMethods()
 * for what each half records. If `budget` is already expired when this is
 * called, skips both halves entirely rather than doing any work.
 *
 * @param {*} obj
 * @param {string} label
 * @param {(message: string, level?: string) => void} [log]
 * @param {ReturnType<typeof createScanBudget>} [budget]
 */
export async function probeHostObject(obj, label, log, budget) {
  if (budget && budget.isExpired()) {
    return { label, skipped: true, reason: budget.reason() };
  }
  const [shape, methods] = await Promise.all([probeObjectShape(obj, label, log, budget), probeSafeMethods(obj, label, log, budget)]);
  return { label, shape, methods };
}
