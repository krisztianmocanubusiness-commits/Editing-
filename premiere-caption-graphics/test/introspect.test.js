import { test } from "node:test";
import assert from "node:assert/strict";

import { withTimeout, resolveHostValueDetailed, resolveHostValue, safeResolve, isPromiseLike } from "../src/ppro/introspect.js";

// A promise that never settles — simulates the confirmed real-host failure
// mode: some Premiere Pro 26.3 host value is Promise-like (has a `.then`)
// but never calls either callback. All timeouts below use a small
// timeoutMs override so this suite stays fast; production code uses the
// larger defaults.
function neverResolves() {
  return new Promise(() => {});
}

test("withTimeout resolves normally when the promise settles before the timeout", async () => {
  const result = await withTimeout(Promise.resolve("done"), 200);
  assert.equal(result, "done");
});

test("withTimeout rejects with an isTimeout error when a promise never settles", async () => {
  const start = Date.now();
  await assert.rejects(() => withTimeout(neverResolves(), 30), (err) => {
    assert.equal(err.isTimeout, true);
    return true;
  });
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected withTimeout to reject quickly, took ${elapsed}ms`);
});

test("withTimeout propagates a genuine rejection (not a timeout)", async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error("real failure")), 200), (err) => {
    assert.equal(err.isTimeout, undefined);
    assert.match(err.message, /real failure/);
    return true;
  });
});

test("withTimeout merges extra meta fields onto the timeout error", async () => {
  await assert.rejects(() => withTimeout(neverResolves(), 20, { label: "component[0].param[3]" }), (err) => {
    assert.equal(err.label, "component[0].param[3]");
    return true;
  });
});

test("resolveHostValueDetailed reports timedOut:true (not a crash, not a hang) for a Promise that never resolves", async () => {
  const start = Date.now();
  const result = await resolveHostValueDetailed(neverResolves(), { timeoutMs: 30 });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 500, `expected resolution to bail out quickly, took ${elapsed}ms`);
});

test("resolveHostValueDetailed passes plain (non-Promise) values through untouched, with timedOut:false", async () => {
  assert.deepEqual(await resolveHostValueDetailed("plain string"), { ok: true, value: "plain string", timedOut: false });
});

test("resolveHostValueDetailed resolves a real Promise and reports timedOut:false", async () => {
  const result = await resolveHostValueDetailed(Promise.resolve("value"), { timeoutMs: 200 });
  assert.deepEqual(result, { ok: true, value: "value", timedOut: false });
});

test("resolveHostValue returns the fallback (not a hang) for a Promise that never resolves", async () => {
  const result = await resolveHostValue(neverResolves(), "fallback", { timeoutMs: 30 });
  assert.equal(result, "fallback");
});

test("safeResolve returns {ok:false, timedOut:true} (not a hang) when the getter returns a Promise that never resolves", async () => {
  const start = Date.now();
  const result = await safeResolve(() => neverResolves(), { timeoutMs: 30 });
  const elapsed = Date.now() - start;
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(elapsed < 500, `expected safeResolve to bail out quickly, took ${elapsed}ms`);
});

test("safeResolve still catches a synchronous throw immediately, without waiting for any timeout", async () => {
  const result = await safeResolve(() => {
    throw new Error("sync boom");
  });
  assert.equal(result.ok, false);
  assert.match(result.error.message, /sync boom/);
});

test("isPromiseLike does not misidentify a plain object with no .then as a promise", () => {
  assert.equal(isPromiseLike({ then: "not a function" }), false);
  assert.equal(isPromiseLike({}), false);
});
