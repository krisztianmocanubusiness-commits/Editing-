import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeHostValue,
  formatSummaryForLog,
  probeObjectShape,
  probeSafeMethods,
  probeHostObject,
  createScanBudget,
  unwrapValueDeep,
} from "../src/ppro/deepProbe.js";

function neverResolves() {
  return new Promise(() => {});
}

test("summarizeHostValue handles null/undefined/primitives", () => {
  assert.deepEqual(summarizeHostValue(null), { kind: "null" });
  assert.deepEqual(summarizeHostValue(undefined), { kind: "undefined" });
  assert.deepEqual(summarizeHostValue(42), { kind: "number", value: 42 });
  assert.deepEqual(summarizeHostValue(true), { kind: "boolean", value: true });
  assert.deepEqual(summarizeHostValue("hello"), { kind: "string", length: 5, preview: "hello" });
});

test("summarizeHostValue truncates very long strings in the preview but keeps the true length", () => {
  const long = "x".repeat(600);
  const summary = summarizeHostValue(long);
  assert.equal(summary.kind, "string");
  assert.equal(summary.length, 600);
  assert.ok(summary.preview.length < 600);
  assert.ok(summary.preview.endsWith("…"));
});

test("summarizeHostValue handles arrays with a bounded sample", () => {
  const summary = summarizeHostValue([1, 2, 3]);
  assert.equal(summary.kind, "array");
  assert.equal(summary.length, 3);
  assert.deepEqual(summary.sample, [
    { kind: "number", value: 1 },
    { kind: "number", value: 2 },
    { kind: "number", value: 3 },
  ]);
});

test("summarizeHostValue never returns the raw object itself, only a JSON-safe summary", () => {
  const raw = { x: 1, y: 2, nested: { deep: true } };
  const summary = summarizeHostValue(raw);
  assert.notEqual(summary, raw);
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test("summarizeHostValue infers point-like from x/y fields", () => {
  assert.equal(summarizeHostValue({ x: 10, y: 20 }).kind, "point-like");
  assert.equal(summarizeHostValue({ horiz: 10, vert: 20 }).kind, "point-like");
});

test("summarizeHostValue infers color-like from red/green/blue fields", () => {
  assert.equal(summarizeHostValue({ red: 255, green: 0, blue: 0 }).kind, "color-like");
});

test("summarizeHostValue infers text-document-like from text + font-ish fields", () => {
  assert.equal(summarizeHostValue({ text: "Hello", fontSize: 24 }).kind, "text-document-like");
});

test("summarizeHostValue infers collection-like from a numeric length field", () => {
  assert.equal(summarizeHostValue({ length: 3 }).kind, "collection-like");
});

test("summarizeHostValue falls back to other-host-object for an unrecognized shape, recording readable fields instead of guessing", () => {
  const summary = summarizeHostValue({ someUnknownField: "abc" });
  assert.equal(summary.kind, "other-host-object");
  assert.deepEqual(summary.shallowPrimitiveFields, { someUnknownField: "abc" });
});

test("summarizeHostValue never throws on a getter that throws", () => {
  const poison = {};
  Object.defineProperty(poison, "broken", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => summarizeHostValue(poison));
});

test("formatSummaryForLog renders a compact one-liner for every summary kind", () => {
  assert.equal(formatSummaryForLog(summarizeHostValue(null)), "null");
  assert.equal(formatSummaryForLog(summarizeHostValue(42)), "number(42)");
  assert.equal(formatSummaryForLog(summarizeHostValue("hi")), 'string("hi")');
  assert.equal(formatSummaryForLog(summarizeHostValue([1, 2])), "array[2]");
  assert.match(formatSummaryForLog(summarizeHostValue({ x: 1, y: 2 })), /point-like/);
});

test("probeObjectShape reports exists:false for null/undefined without throwing", async () => {
  assert.deepEqual(await probeObjectShape(null, "thing"), { label: "thing", exists: false });
  assert.deepEqual(await probeObjectShape(undefined, "thing"), { label: "thing", exists: false });
});

test("probeObjectShape records own keys, own property names, constructor name, and per-field summaries", async () => {
  const obj = { a: 1, b: "two" };
  const result = await probeObjectShape(obj, "thing");
  assert.equal(result.label, "thing");
  assert.equal(result.exists, true);
  assert.equal(result.constructorName, "Object");
  assert.deepEqual(result.ownKeys.sort(), ["a", "b"]);
  assert.ok(result.ownPropertyNames.includes("a"));
  assert.deepEqual(result.fields.a, { wasPromiseLike: false, summary: { kind: "number", value: 1 } });
  assert.deepEqual(result.fields.b, { wasPromiseLike: false, summary: { kind: "string", length: 3, preview: "two" } });
});

test("probeObjectShape flags a field that was Promise-like and records its resolved value", async () => {
  const obj = { pending: Promise.resolve("resolved value") };
  const result = await probeObjectShape(obj, "thing");
  assert.equal(result.fields.pending.wasPromiseLike, true);
  assert.deepEqual(result.fields.pending.summary, { kind: "string", length: 14, preview: "resolved value" });
});

test("probeObjectShape records a read error instead of throwing when a field getter throws", async () => {
  const obj = {};
  Object.defineProperty(obj, "broken", {
    enumerable: true,
    configurable: true,
    get() {
      throw new Error("getter boom");
    },
  });
  const result = await probeObjectShape(obj, "thing");
  assert.match(result.fields.broken.readError, /getter boom/);
});

test("probeObjectShape separates method names from non-method property names", async () => {
  const obj = { value: 1, getFoo() { return "bar"; } };
  const result = await probeObjectShape(obj, "thing");
  assert.ok(result.prototypeMethodNames.includes("getFoo"));
  assert.ok(!result.prototypeMethodNames.includes("value"));
  assert.ok(result.prototypeNonMethodNames.includes("value"));
});

test("probeSafeMethods calls zero-argument getter-named methods and records their results", async () => {
  const obj = { getFoo: () => "bar", isReady: () => true };
  const result = await probeSafeMethods(obj, "thing");
  const foo = result.methods.find((m) => m.name === "getFoo");
  const ready = result.methods.find((m) => m.name === "isReady");
  assert.equal(foo.called, true);
  assert.equal(foo.ok, true);
  assert.deepEqual(foo.resultSummary, { kind: "string", length: 3, preview: "bar" });
  assert.equal(ready.called, true);
  assert.deepEqual(ready.resultSummary, { kind: "boolean", value: true });
});

test("probeSafeMethods never calls a method that requires arguments", async () => {
  const obj = { setFoo: (x) => x };
  const result = await probeSafeMethods(obj, "thing");
  const entry = result.methods.find((m) => m.name === "setFoo");
  assert.equal(entry.called, false);
  assert.equal(entry.reason, "needs-arguments");
});

test("probeSafeMethods never calls a zero-argument method whose name suggests a side effect, even if it looks getter-shaped", async () => {
  let called = false;
  const obj = { removeThing: () => { called = true; } };
  const result = await probeSafeMethods(obj, "thing");
  const entry = result.methods.find((m) => m.name === "removeThing");
  assert.equal(entry.called, false);
  assert.equal(called, false, "the dangerous-named method must never actually be invoked");
});

test("probeSafeMethods lists (but does not call) a zero-arg method that doesn't look like a getter by name", async () => {
  const obj = { doTheThing: () => "result" };
  const result = await probeSafeMethods(obj, "thing");
  const entry = result.methods.find((m) => m.name === "doTheThing");
  assert.equal(entry.called, false);
});

test("probeSafeMethods records a thrown/rejected call instead of crashing", async () => {
  const obj = {
    getBroken: () => {
      throw new Error("boom");
    },
  };
  const result = await probeSafeMethods(obj, "thing");
  const entry = result.methods.find((m) => m.name === "getBroken");
  assert.equal(entry.called, true);
  assert.equal(entry.ok, false);
  assert.match(entry.error, /boom/);
});

test("probeSafeMethods reports exists:false for null/undefined without throwing", async () => {
  assert.deepEqual(await probeSafeMethods(null, "thing"), { label: "thing", exists: false, methods: [] });
});

test("probeHostObject combines shape and method probing into one result", async () => {
  const obj = { a: 1, getFoo: () => "bar" };
  const result = await probeHostObject(obj, "thing");
  assert.equal(result.label, "thing");
  assert.equal(result.shape.exists, true);
  assert.equal(result.methods.exists, true);
  assert.ok(result.methods.methods.some((m) => m.name === "getFoo" && m.called === true));
});

// --- Regression tests: hang-proofing (a Promise that never resolves, a
// cyclic host object, an extremely deep prototype chain, a collection with
// a huge reported length) and budget/cancellation-driven early stopping. ---

test("probeObjectShape reports timedOut:true for a field whose value is a Promise that never resolves, instead of hanging", async () => {
  const start = Date.now();
  const obj = { pending: neverResolves() };
  const result = await probeObjectShape(obj, "thing");
  const elapsed = Date.now() - start;
  assert.deepEqual(result.fields.pending, { wasPromiseLike: true, timedOut: true, method: "thing.pending", stage: "field-read" });
  assert.ok(elapsed < 2000, `expected probeObjectShape to bail out well under the default per-call timeout budget, took ${elapsed}ms`);
});

test("probeSafeMethods reports timedOut:true for a method that returns a Promise that never resolves, instead of hanging", async () => {
  const start = Date.now();
  const obj = { getStuck: () => neverResolves() };
  const result = await probeSafeMethods(obj, "thing");
  const elapsed = Date.now() - start;
  const entry = result.methods.find((m) => m.name === "getStuck");
  assert.deepEqual(entry, { name: "getStuck", argCount: 0, called: true, timedOut: true, method: "thing.getStuck()", stage: "method-call" });
  assert.ok(elapsed < 2000, `expected probeSafeMethods to bail out well under the default per-call timeout budget, took ${elapsed}ms`);
});

test("summarizeHostValue detects a cyclic array (an array containing itself) instead of recursing forever", () => {
  const arr = [1, 2];
  arr.push(arr);
  const start = Date.now();
  const summary = summarizeHostValue(arr);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected summarizeHostValue to return promptly for a cyclic array, took ${elapsed}ms`);
  assert.equal(summary.kind, "array");
  assert.equal(summary.sample[2].kind, "cyclic-reference");
});

test("summarizeHostValue detects a self-referential object without recursing into it more than once", () => {
  const obj = {};
  obj.self = obj;
  assert.doesNotThrow(() => summarizeHostValue(obj));
});

test("summarizeHostValue never attempts to iterate a non-array object by a huge reported .length — classification only reads the field's value", () => {
  const start = Date.now();
  const summary = summarizeHostValue({ length: 999999999 });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected this to return promptly regardless of the reported length, took ${elapsed}ms`);
  assert.equal(summary.kind, "collection-like");
  assert.equal(summary.shallowPrimitiveFields.length, 999999999);
});

test("probeObjectShape/probeSafeMethods bound an extremely deep prototype chain to MAX_PROTO_DEPTH instead of walking all of it", async () => {
  // Build a chain of 50 nested prototypes, each contributing one uniquely-
  // named method — real prototype chains are never this deep, but nothing
  // should hang or crash if one somehow were.
  let proto = Object.prototype;
  for (let i = 0; i < 50; i++) {
    const level = Object.create(proto);
    level[`getLevel${i}`] = () => i;
    proto = level;
  }
  const obj = Object.create(proto);

  const shape = await probeObjectShape(obj, "thing");
  const methods = await probeSafeMethods(obj, "thing");

  // Only names from the first few prototype levels should have been
  // collected — not all 50 — proving the depth cap is actually enforced.
  assert.ok(shape.prototypeMethodNames.length < 50, `expected far fewer than 50 method names, got ${shape.prototypeMethodNames.length}`);
  assert.ok(methods.allMethodNames.length < 50, `expected far fewer than 50 method names, got ${methods.allMethodNames.length}`);
});

test("createScanBudget reports expired once totalMs has elapsed", async () => {
  const budget = createScanBudget({ totalMs: 10 });
  assert.equal(budget.isExpired(), false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(budget.isExpired(), true);
  assert.equal(budget.reason(), "time-budget-exceeded");
});

test("createScanBudget reports expired immediately once its cancelToken is marked cancelled, regardless of totalMs", () => {
  const cancelToken = { cancelled: false };
  const budget = createScanBudget({ totalMs: 60000, cancelToken });
  assert.equal(budget.isExpired(), false);
  cancelToken.cancelled = true;
  assert.equal(budget.isExpired(), true);
  assert.equal(budget.reason(), "cancelled");
});

test("probeObjectShape stops reading further fields once the budget expires, marking the result truncated", async () => {
  const cancelToken = { cancelled: true }; // already expired
  const budget = createScanBudget({ totalMs: 60000, cancelToken });
  const obj = { a: 1, b: 2, c: 3 };
  const result = await probeObjectShape(obj, "thing", undefined, budget);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "cancelled");
});

test("probeObjectShape truncates mid-loop when the budget expires partway through, instead of processing every remaining field", async () => {
  let reads = 0;
  const cancelToken = { cancelled: false };
  const budget = createScanBudget({ totalMs: 60000, cancelToken });
  const obj = {};
  Object.defineProperty(obj, "a", {
    enumerable: true,
    get() {
      reads += 1;
      cancelToken.cancelled = true; // expire the budget partway through the loop
      return 1;
    },
  });
  obj.b = 2;
  obj.c = 3;
  const result = await probeObjectShape(obj, "thing", undefined, budget);
  assert.equal(reads, 1, "only the first field should have been read before the budget expired");
  assert.equal(result.truncated, true);
});

test("probeSafeMethods stops calling further methods once the budget expires, listing the rest as skipped rather than calling them", async () => {
  const cancelToken = { cancelled: false };
  const budget = createScanBudget({ totalMs: 60000, cancelToken });
  let calls = 0;
  const obj = {
    getFirst: () => {
      calls += 1;
      cancelToken.cancelled = true;
      return "first";
    },
    getSecond: () => {
      calls += 1;
      return "second";
    },
  };
  const result = await probeSafeMethods(obj, "thing", undefined, budget);
  assert.equal(calls, 1, "the second method must never be called once the budget expired");
  const second = result.methods.find((m) => m.name === "getSecond");
  assert.equal(second.called, false);
  assert.equal(second.reason, "cancelled");
});

test("probeHostObject skips both shape and method probing entirely when the budget is already expired", async () => {
  const budget = createScanBudget({ totalMs: 60000, cancelToken: { cancelled: true } });
  const obj = { a: 1, getFoo: () => "bar" };
  const result = await probeHostObject(obj, "thing", undefined, budget);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "cancelled");
});

// --- Regression tests: the confirmed real-host bug where Premiere's
// host-proxy functions report function.length (argCount) as 0 even when a
// real argument IS required — getValueAtTime() and getParam() both do
// this, which used to make probeSafeMethods auto-call them with no
// argument on every param, reliably timing out and burning almost the
// entire scan budget before AE.ADBE Text could be reached. ---

test("probeSafeMethods never calls getValueAtTime even though the host reports its argCount (function.length) as 0", async () => {
  let called = false;
  const obj = {
    // A real host-proxy function's .length really does report 0 here even
    // though a TickTime argument is required — this fake mirrors that.
    getValueAtTime: function () {
      called = true;
      return "should never run";
    },
  };
  assert.equal(obj.getValueAtTime.length, 0, "sanity check: this fake reports argCount 0, same as the real host bug");
  const result = await probeSafeMethods(obj, "param");
  const entry = result.methods.find((m) => m.name === "getValueAtTime");
  assert.equal(entry.called, false);
  assert.equal(called, false, "getValueAtTime must never actually be invoked without a deliberately supplied TickTime");
});

test("probeSafeMethods never calls getParam even though the host reports its argCount as 0 (returns 'Invalid parameter' when auto-called with no index)", async () => {
  let called = false;
  const obj = {
    getParam: function () {
      called = true;
      return "Invalid parameter";
    },
  };
  assert.equal(obj.getParam.length, 0);
  const result = await probeSafeMethods(obj, "component");
  const entry = result.methods.find((m) => m.name === "getParam");
  assert.equal(entry.called, false);
  assert.equal(called, false, "getParam must never be auto-called without an explicit index");
});

test("probeSafeMethods never calls keyframe-search or createSetValueAction methods regardless of reported argCount", async () => {
  const calls = [];
  const obj = {
    findNearestKeyframe: () => calls.push("findNearestKeyframe"),
    findNextKeyframe: () => calls.push("findNextKeyframe"),
    findPreviousKeyframe: () => calls.push("findPreviousKeyframe"),
    createSetValueAction: () => calls.push("createSetValueAction"),
  };
  for (const fn of Object.values(obj)) assert.equal(fn.length, 0);
  const result = await probeSafeMethods(obj, "param");
  for (const name of Object.keys(obj)) {
    const entry = result.methods.find((m) => m.name === name);
    assert.equal(entry.called, false, `${name} must never be auto-called`);
  }
  assert.deepEqual(calls, [], "none of the denylisted methods should have actually run");
});

// --- Regression tests: inherited (prototype-only) accessor properties —
// confirmed real-host shape for ComponentParam.getStartValue()'s
// Keyframe/PointKeyframe results, whose `.value`/`.position` are defined
// on the constructor's PROTOTYPE, not as own-enumerable properties on the
// instance. Object.keys()-only enumeration never sees these at all, which
// is why the probe used to report `value: {}`. ---

function makeInheritedAccessorInstance(props) {
  const proto = {};
  for (const [name, value] of Object.entries(props)) {
    Object.defineProperty(proto, name, { enumerable: false, configurable: true, get: () => value });
  }
  return Object.create(proto);
}

test("probeObjectShape reads inherited (prototype-only) displayName, not just own-enumerable properties", async () => {
  const instance = makeInheritedAccessorInstance({ displayName: "Fill Color" });
  assert.deepEqual(Object.keys(instance), [], "sanity check: displayName is NOT an own-enumerable key on this instance");
  const result = await probeObjectShape(instance, "param");
  assert.ok(result.prototypeNonMethodNames.includes("displayName"));
  assert.deepEqual(result.inheritedFields.displayName, { wasPromiseLike: false, summary: { kind: "string", length: 10, preview: "Fill Color" } });
});

test("probeObjectShape reads an inherited Keyframe.value accessor property", async () => {
  const keyframe = makeInheritedAccessorInstance({ value: 42 });
  const result = await probeObjectShape(keyframe, "param.getStartValue()");
  assert.deepEqual(result.inheritedFields.value, { wasPromiseLike: false, summary: { kind: "number", value: 42 } });
});

test("probeObjectShape reads an inherited PointKeyframe.position accessor property", async () => {
  const pointKeyframe = makeInheritedAccessorInstance({ position: { x: 100, y: 200 } });
  const result = await probeObjectShape(pointKeyframe, "param.getStartValue()");
  assert.equal(result.inheritedFields.position.wasPromiseLike, false);
  assert.equal(result.inheritedFields.position.summary.kind, "point-like");
  assert.deepEqual(result.inheritedFields.position.summary.shallowPrimitiveFields, { x: 100, y: 200 });
});

// --- unwrapValueDeep ---

test("unwrapValueDeep passes primitives straight through", async () => {
  assert.equal(await unwrapValueDeep("hello"), "hello");
  assert.equal(await unwrapValueDeep(42), 42);
  assert.equal(await unwrapValueDeep(true), true);
  assert.equal(await unwrapValueDeep(null), null);
  assert.equal(await unwrapValueDeep(undefined), null);
});

test("unwrapValueDeep unwraps a single-field { value: X } wrapper (Keyframe shape) down to the primitive", async () => {
  const keyframe = { value: "KERIS_DIAGNOSTIC_SENTINEL" };
  assert.equal(await unwrapValueDeep(keyframe), "KERIS_DIAGNOSTIC_SENTINEL");
});

test("unwrapValueDeep unwraps an inherited (prototype-only) Keyframe.value accessor, not just an own-enumerable one", async () => {
  const keyframe = makeInheritedAccessorInstance({ value: 100 });
  assert.equal(await unwrapValueDeep(keyframe), 100);
});

test("unwrapValueDeep recurses through nested { value: { value: X } } wrapping", async () => {
  const nested = { value: { value: "deeply nested" } };
  assert.equal(await unwrapValueDeep(nested), "deeply nested");
});

test("unwrapValueDeep reads PointF-shaped values into { x, y }", async () => {
  const point = { x: 12.5, y: -3 };
  assert.deepEqual(await unwrapValueDeep(point), { x: 12.5, y: -3 });
});

test("unwrapValueDeep reads PointF fields case-insensitively", async () => {
  const point = { X: 1, Y: 2 };
  assert.deepEqual(await unwrapValueDeep(point), { x: 1, y: 2 });
});

test("unwrapValueDeep reads Color-shaped values into { red, green, blue, alpha }", async () => {
  const color = { red: 255, green: 128, blue: 0, alpha: 1 };
  assert.deepEqual(await unwrapValueDeep(color), { red: 255, green: 128, blue: 0, alpha: 1 });
});

test("unwrapValueDeep reads a Color without alpha into { red, green, blue } only", async () => {
  const color = { red: 10, green: 20, blue: 30 };
  assert.deepEqual(await unwrapValueDeep(color), { red: 10, green: 20, blue: 30 });
});

test("unwrapValueDeep returns null for a shape it can't reduce (not value/point/color-shaped)", async () => {
  const mystery = { foo: 1, bar: 2 };
  assert.equal(await unwrapValueDeep(mystery), null);
});

test("unwrapValueDeep detects a self-referential object instead of recursing forever", async () => {
  const cyclic = {};
  cyclic.value = cyclic;
  const start = Date.now();
  const result = await unwrapValueDeep(cyclic);
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 2000, `expected cycle detection to bail out quickly, took ${elapsed}ms`);
});

test("unwrapValueDeep stops at the depth cap instead of recursing indefinitely through nested { value } wrappers", async () => {
  let deeplyNested = "bottom";
  for (let i = 0; i < 20; i++) deeplyNested = { value: deeplyNested };
  const start = Date.now();
  const result = await unwrapValueDeep(deeplyNested);
  const elapsed = Date.now() - start;
  assert.equal(result, null, "expected the depth cap to stop unwrapping before reaching the bottom primitive");
  assert.ok(elapsed < 2000, `expected the depth-capped unwrap to finish quickly, took ${elapsed}ms`);
});

test("unwrapValueDeep returns null (not a hang) for a value that is a Promise that never resolves", async () => {
  const start = Date.now();
  const result = await unwrapValueDeep(neverResolves());
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 2000, `expected unwrapValueDeep to time out well under 2s, took ${elapsed}ms`);
});

test("unwrapValueDeep returns null (not a hang) when a candidate field's own value is a Promise that never resolves", async () => {
  const keyframe = { value: neverResolves() };
  const start = Date.now();
  const result = await unwrapValueDeep(keyframe);
  const elapsed = Date.now() - start;
  assert.equal(result, null);
  assert.ok(elapsed < 2000, `expected unwrapValueDeep to time out well under 2s, took ${elapsed}ms`);
});
