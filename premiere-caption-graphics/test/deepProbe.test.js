import { test } from "node:test";
import assert from "node:assert/strict";

import {
  summarizeHostValue,
  formatSummaryForLog,
  probeObjectShape,
  probeSafeMethods,
  probeHostObject,
} from "../src/ppro/deepProbe.js";

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
