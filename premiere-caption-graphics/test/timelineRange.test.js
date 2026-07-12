import { test } from "node:test";
import assert from "node:assert/strict";

import { isValidTimelineSeconds, getSelectedRangeSeconds, resolveInsertionTimeSec, MAX_SANE_TIMELINE_SECONDS } from "../src/ppro/timelineRange.js";

function noopLog() {}

function fakeTickTime(seconds) {
  return { seconds };
}

// --- isValidTimelineSeconds ---
//
// Regression coverage for the confirmed real-host bug: sequence.getInPoint()
// (or getOutPoint()) can resolve to a huge sentinel value — observed as
// exactly -400000 seconds — instead of 0 or throwing when the in/out point
// isn't actually set.

test("isValidTimelineSeconds accepts 0 and ordinary positive timeline positions", () => {
  assert.equal(isValidTimelineSeconds(0), true);
  assert.equal(isValidTimelineSeconds(12.5), true);
  assert.equal(isValidTimelineSeconds(3600), true);
});

test("isValidTimelineSeconds rejects the exact confirmed real-host sentinel (-400000s)", () => {
  assert.equal(isValidTimelineSeconds(-400000), false);
});

test("isValidTimelineSeconds rejects any negative value", () => {
  assert.equal(isValidTimelineSeconds(-0.001), false);
  assert.equal(isValidTimelineSeconds(-1), false);
});

test("isValidTimelineSeconds rejects NaN and non-finite values", () => {
  assert.equal(isValidTimelineSeconds(NaN), false);
  assert.equal(isValidTimelineSeconds(Infinity), false);
  assert.equal(isValidTimelineSeconds(-Infinity), false);
});

test("isValidTimelineSeconds accepts exactly MAX_SANE_TIMELINE_SECONDS and rejects just beyond it", () => {
  assert.equal(isValidTimelineSeconds(MAX_SANE_TIMELINE_SECONDS), true);
  assert.equal(isValidTimelineSeconds(MAX_SANE_TIMELINE_SECONDS + 1), false);
});

// --- getSelectedRangeSeconds ---

test("getSelectedRangeSeconds returns the real in/out range when both are valid and out > in", async () => {
  const sequence = {
    getEndTime: async () => fakeTickTime(120),
    getInPoint: async () => fakeTickTime(10),
    getOutPoint: async () => fakeTickTime(30),
  };
  const range = await getSelectedRangeSeconds(sequence);
  assert.deepEqual(range, { startSec: 10, endSec: 30 });
});

test("getSelectedRangeSeconds falls back to 0..sequenceEnd when in/out collapse to 0..0 (no real selection)", async () => {
  const sequence = {
    getEndTime: async () => fakeTickTime(120),
    getInPoint: async () => fakeTickTime(0),
    getOutPoint: async () => fakeTickTime(0),
  };
  const range = await getSelectedRangeSeconds(sequence);
  assert.deepEqual(range, { startSec: 0, endSec: 120 });
});

test("getSelectedRangeSeconds rejects a sentinel in-point (-400000s) even though outSec > inSec numerically — the exact confirmed bug", async () => {
  const sequence = {
    getEndTime: async () => fakeTickTime(120),
    getInPoint: async () => fakeTickTime(-400000),
    getOutPoint: async () => fakeTickTime(30),
  };
  const range = await getSelectedRangeSeconds(sequence);
  // -400000 < 30, so the old `outSec > inSec` check alone would have
  // accepted this as "a valid range" and returned startSec: -400000.
  assert.deepEqual(range, { startSec: 0, endSec: 120 });
});

test("getSelectedRangeSeconds rejects a sentinel out-point too, not just the in-point", async () => {
  const sequence = {
    getEndTime: async () => fakeTickTime(120),
    getInPoint: async () => fakeTickTime(10),
    getOutPoint: async () => fakeTickTime(-400000),
  };
  const range = await getSelectedRangeSeconds(sequence);
  assert.deepEqual(range, { startSec: 0, endSec: 120 });
});

test("getSelectedRangeSeconds falls back to 0 for endSec when getEndTime() itself returns an invalid/sentinel value", async () => {
  const sequence = {
    getEndTime: async () => fakeTickTime(-400000),
    getInPoint: async () => fakeTickTime(0),
    getOutPoint: async () => fakeTickTime(0),
  };
  const range = await getSelectedRangeSeconds(sequence);
  assert.deepEqual(range, { startSec: 0, endSec: 0 });
});

test("getSelectedRangeSeconds falls back to sequence end when getInPoint/getOutPoint aren't functions on this host version", async () => {
  const sequence = { getEndTime: async () => fakeTickTime(90) };
  const range = await getSelectedRangeSeconds(sequence);
  assert.deepEqual(range, { startSec: 0, endSec: 90 });
});

test("getSelectedRangeSeconds falls back silently (not a crash) when getInPoint/getOutPoint throw", async () => {
  const sequence = {
    getEndTime: async () => fakeTickTime(90),
    getInPoint: async () => { throw new Error("not supported"); },
    getOutPoint: async () => fakeTickTime(30),
  };
  const range = await getSelectedRangeSeconds(sequence);
  assert.deepEqual(range, { startSec: 0, endSec: 90 });
});

// --- resolveInsertionTimeSec ---
//
// Regression coverage for the task's exact required fallback order:
// current playhead if valid, sequence in-point if valid, 0 seconds
// otherwise — with every candidate validated so an invalid/sentinel value
// can never reach a MOGRT insertion call.

test("resolveInsertionTimeSec uses the current playhead when a playhead getter exists and returns a valid time", async () => {
  const sequence = {
    getPlayerPosition: async () => fakeTickTime(45.5),
    getEndTime: async () => fakeTickTime(120),
  };
  const sec = await resolveInsertionTimeSec(sequence, noopLog);
  assert.equal(sec, 45.5);
});

test("resolveInsertionTimeSec tries getPlayheadPosition and getCurrentTime too, in order, if getPlayerPosition isn't present", async () => {
  const sequence = {
    getCurrentTime: async () => fakeTickTime(7),
    getEndTime: async () => fakeTickTime(120),
  };
  const sec = await resolveInsertionTimeSec(sequence, noopLog);
  assert.equal(sec, 7);
});

test("resolveInsertionTimeSec falls back to the sequence in-point when the playhead getter returns the confirmed real-host sentinel (-400000s)", async () => {
  const sequence = {
    getPlayerPosition: async () => fakeTickTime(-400000),
    getEndTime: async () => fakeTickTime(120),
    getInPoint: async () => fakeTickTime(15),
    getOutPoint: async () => fakeTickTime(45),
  };
  const sec = await resolveInsertionTimeSec(sequence, noopLog);
  assert.equal(sec, 15);
});

test("resolveInsertionTimeSec falls back to the next playhead candidate when one throws", async () => {
  const sequence = {
    getPlayerPosition: async () => { throw new Error("not implemented"); },
    getPlayheadPosition: async () => fakeTickTime(8),
    getEndTime: async () => fakeTickTime(120),
  };
  const sec = await resolveInsertionTimeSec(sequence, noopLog);
  assert.equal(sec, 8);
});

test("resolveInsertionTimeSec falls back all the way to 0 when no playhead getter exists and no in-point is set", async () => {
  const sequence = { getEndTime: async () => fakeTickTime(120) };
  const sec = await resolveInsertionTimeSec(sequence, noopLog);
  assert.equal(sec, 0);
});

test("resolveInsertionTimeSec never returns a negative or absurd value, even when every source returns the sentinel", async () => {
  const sequence = {
    getPlayerPosition: async () => fakeTickTime(-400000),
    getEndTime: async () => fakeTickTime(-400000),
    getInPoint: async () => fakeTickTime(-400000),
    getOutPoint: async () => fakeTickTime(-399999), // numerically greater than inSec, but still itself invalid
  };
  const sec = await resolveInsertionTimeSec(sequence, noopLog);
  assert.equal(sec, 0);
  assert.ok(sec >= 0, "resolveInsertionTimeSec must never return a negative insertion time");
});

test("resolveInsertionTimeSec logs a warning when a playhead candidate returns an invalid time, then still succeeds via the next source", async () => {
  const messages = [];
  const sequence = {
    getPlayerPosition: async () => fakeTickTime(-400000),
    getEndTime: async () => fakeTickTime(120),
    getInPoint: async () => fakeTickTime(5),
    getOutPoint: async () => fakeTickTime(50),
  };
  const sec = await resolveInsertionTimeSec(sequence, (message, level) => messages.push({ message, level }));
  assert.equal(sec, 5);
  assert.ok(messages.some((m) => m.level === "warn" && /invalid\/out-of-range/.test(m.message)));
});
