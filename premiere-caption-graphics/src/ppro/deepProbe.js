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
 * Every function here is careful never to throw and never to call anything
 * that looks state-mutating (see DANGEROUS_NAME_FRAGMENTS) — this is a
 * read-only exploration tool, not a way to script Premiere.
 */
import { safe, isPromiseLike, resolveHostValue, safeResolve } from "./introspect.js";

const MAX_PROTO_DEPTH = 6;
const MAX_OWN_PROPERTY_NAMES = 300;
const MAX_METHOD_CALLS = 80;
const MAX_ARRAY_SAMPLE = 20;
const MAX_STRING_PREVIEW = 500;

/** Every own + inherited (bounded depth) property name, deduped, with a note of which prototype level each came from. */
function walkPrototypeChain(obj) {
  const seen = new Map(); // name -> first depth seen at
  let current = obj;
  let depth = 0;
  while (current !== null && current !== undefined && depth <= MAX_PROTO_DEPTH) {
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
// these verbs suggest a side effect.
const DANGEROUS_NAME_FRAGMENTS = [
  "set", "remove", "delete", "clear", "close", "dispose", "destroy",
  "create", "add", "insert", "execute", "select", "update", "write",
  "save", "move", "copy", "rename", "refresh", "reset", "undo", "redo",
  "import", "export", "load", "unload", "open",
];

function isSafeToCallByName(name) {
  const lower = name.toLowerCase();
  if (DANGEROUS_NAME_FRAGMENTS.some((frag) => lower.includes(frag))) return false;
  // Only call things that look like getters/predicates/stringifiers by
  // convention — anything else is listed but not invoked.
  return /^(get|is|has)[A-Z0-9]/.test(name) || name === "toString" || name === "valueOf";
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
 * @param {*} value
 * @returns {Object}
 */
export function summarizeHostValue(value) {
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

  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      sample: value.slice(0, MAX_ARRAY_SAMPLE).map((v) => summarizeHostValue(v)),
    };
  }

  if (t === "object") {
    const ownPropertyNames = (safe(() => Object.getOwnPropertyNames(value)).value ?? []).slice(0, MAX_OWN_PROPERTY_NAMES);
    const ownKeys = safe(() => Object.keys(value)).value ?? [];
    const constructorName = safe(() => value.constructor?.name).value ?? null;

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
 * Inspect an object's real shape: own property names, own enumerable keys,
 * prototype-chain property/method names (bounded depth), constructor name,
 * and — for every OWN enumerable key — its resolved value's summary and
 * whether it was Promise-like before resolution. Never throws, never
 * touches anything not already reachable via safe property reads.
 *
 * @param {*} obj
 * @param {string} label
 * @param {(message: string, level?: string) => void} [log]
 */
export async function probeObjectShape(obj, label, log) {
  if (obj === null || obj === undefined) {
    return { label, exists: false };
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
  for (const name of ownKeys.slice(0, MAX_OWN_PROPERTY_NAMES)) {
    const raw = safe(() => obj[name]);
    if (!raw.ok) {
      fields[name] = { readError: String(raw.error.message || raw.error) };
      continue;
    }
    const wasPromiseLike = isPromiseLike(raw.value);
    const resolved = await resolveHostValue(raw.value, undefined, { log, label: `${label}.${name}` });
    fields[name] = { wasPromiseLike, summary: summarizeHostValue(resolved) };
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
  };
}

/**
 * Enumerate every method on an object's prototype chain (bounded depth) and
 * safely CALL the ones that look like zero-argument, read-only getters by
 * name (see isSafeToCallByName) — everything else is listed but not
 * invoked, so this can never trigger a state-mutating host call. Bounded to
 * MAX_METHOD_CALLS actual invocations as a sanity cap.
 *
 * @param {*} obj
 * @param {string} label
 * @param {(message: string, level?: string) => void} [log]
 */
export async function probeSafeMethods(obj, label, log) {
  if (obj === null || obj === undefined) {
    return { label, exists: false, methods: [] };
  }

  const protoNames = walkPrototypeChain(obj);
  const methodNames = [...protoNames.keys()].filter(
    (name) => name !== "constructor" && safe(() => typeof obj[name] === "function").value === true
  );

  const methods = [];
  let calls = 0;
  for (const name of methodNames) {
    const argCount = safe(() => obj[name].length).value ?? 0;
    const eligible = argCount === 0 && isSafeToCallByName(name);
    if (!eligible || calls >= MAX_METHOD_CALLS) {
      methods.push({ name, argCount, called: false, reason: calls >= MAX_METHOD_CALLS ? "call-cap-reached" : argCount > 0 ? "needs-arguments" : "name-not-recognized-as-safe-getter" });
      continue;
    }
    calls += 1;
    const result = await safeResolve(() => obj[name](), { log, label: `${label}.${name}()` });
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
 * for what each half records.
 *
 * @param {*} obj
 * @param {string} label
 * @param {(message: string, level?: string) => void} [log]
 */
export async function probeHostObject(obj, label, log) {
  const [shape, methods] = await Promise.all([probeObjectShape(obj, label, log), probeSafeMethods(obj, label, log)]);
  return { label, shape, methods };
}
