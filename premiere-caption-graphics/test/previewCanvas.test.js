import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPreview, measureTextWidth, ctxSave, ctxRestore } from "../src/ui/previewCanvas.js";
import { createDefaultPreset } from "../src/presets/types.js";
import { makeChunk } from "../src/caption/types.js";

// Minimal CanvasRenderingContext2D stand-in. `withMeasureText`/`withGradient`/
// `withSaveRestore` control whether those methods exist at all, so tests can
// simulate Premiere Pro 26.3's UXP canvas, which is missing all three
// (`ctx.measureText is not a function`, `ctx.save is not a function`).
function createStubContext({ withMeasureText = true, withGradient = true, withSaveRestore = true } = {}) {
  const ctx = {
    clearRect() {},
    fillRect() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    fill() {},
    fillText() {},
  };
  if (withSaveRestore) {
    ctx.save = () => {};
    ctx.restore = () => {};
  }
  if (withMeasureText) {
    ctx.measureText = (text) => ({ width: text.length * 10 });
  }
  if (withGradient) {
    ctx.createLinearGradient = () => ({ addColorStop() {} });
  }
  return ctx;
}

function createStubCanvas(width, height, ctxOptions) {
  const ctx = createStubContext(ctxOptions);
  return { width, height, getContext: () => ctx };
}

// This must be the first test in this file: warnedOnce is module-level
// state that persists across tests declared in the same file (Node's test
// runner isolates module state *per file*, not per test — verified
// separately), so a later test's earlier measureTextWidth() call would
// otherwise have already consumed the "only warn once" slot before this
// assertion runs.
test("measureTextWidth's missing-measureText warning fires exactly once, with the exact required message", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const ctx = createStubContext({ withMeasureText: false });
    measureTextWidth(ctx, "a", 20);
    measureTextWidth(ctx, "b", 20);
    measureTextWidth(ctx, "c", 20);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["[Caption Graphics Studio] canvas measureText unavailable; using width approximation"]);
});

// Must run before any other test exercises a save/restore-less ctx (see the
// comment on the measureText warn-once test above — same per-file module
// state caveat, just for the "save-restore" warnOnce key instead).
test("canvas save/restore missing-method warning fires exactly once, with the exact required message", () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (msg) => warnings.push(msg);
  try {
    const ctx = createStubContext({ withSaveRestore: false });
    ctxSave(ctx);
    ctxSave(ctx);
    ctxSave(ctx);
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(warnings, ["[Caption Graphics Studio] canvas save/restore unavailable; manually preserving state"]);
});

test("ctxSave/ctxRestore delegate to the real save()/restore() when both exist", () => {
  let saveCalls = 0;
  let restoreCalls = 0;
  const ctx = { save: () => saveCalls++, restore: () => restoreCalls++, fillStyle: "red" };
  const saved = ctxSave(ctx);
  ctx.fillStyle = "blue";
  ctxRestore(ctx, saved);
  assert.equal(saveCalls, 1);
  assert.equal(restoreCalls, 1);
});

test("ctxSave/ctxRestore manually preserve and restore tracked properties when save/restore are unavailable", () => {
  const ctx = { fillStyle: "red", globalAlpha: 1, font: "10px sans-serif", shadowBlur: 0 };
  const saved = ctxSave(ctx);
  ctx.fillStyle = "blue";
  ctx.globalAlpha = 0.5;
  ctx.font = "20px sans-serif";
  ctx.shadowBlur = 8;
  ctxRestore(ctx, saved);
  assert.equal(ctx.fillStyle, "red");
  assert.equal(ctx.globalAlpha, 1);
  assert.equal(ctx.font, "10px sans-serif");
  assert.equal(ctx.shadowBlur, 0);
});

test("ctxSave falls back to manual snapshot if only one of save/restore exists (never calls save without a matching restore)", () => {
  const ctx = { save: () => assert.fail("save() should not be called without restore() also being present"), fillStyle: "red" };
  const saved = ctxSave(ctx);
  ctx.fillStyle = "blue";
  ctxRestore(ctx, saved);
  assert.equal(ctx.fillStyle, "red");
});

test("ctxRestore never throws even if reassigning a snapshotted property throws (e.g. a read-only host property)", () => {
  const ctx = {};
  Object.defineProperty(ctx, "fillStyle", {
    enumerable: true,
    configurable: true,
    get() {
      return "red";
    },
    set() {
      throw new Error("read-only on this host");
    },
  });
  const saved = ctxSave(ctx);
  assert.doesNotThrow(() => ctxRestore(ctx, saved));
});

test("measureTextWidth delegates to ctx.measureText when it's available", () => {
  const ctx = createStubContext({ withMeasureText: true });
  assert.equal(measureTextWidth(ctx, "abc", 40), 30); // stub: text.length * 10
});

test("measureTextWidth's fallback returns a positive, finite approximation when ctx.measureText is missing", () => {
  const ctx = createStubContext({ withMeasureText: false });
  const width = measureTextWidth(ctx, "HELLO WORLD", 72, 700, "Helvetica Neue");
  assert.ok(Number.isFinite(width));
  assert.ok(width > 0);
});

test("measureTextWidth's fallback scales roughly with font size", () => {
  const ctx = createStubContext({ withMeasureText: false });
  const small = measureTextWidth(ctx, "SAMPLE", 20);
  const large = measureTextWidth(ctx, "SAMPLE", 100);
  assert.ok(large > small);
});

test("measureTextWidth's fallback never returns NaN for an empty string", () => {
  const ctx = createStubContext({ withMeasureText: false });
  assert.equal(measureTextWidth(ctx, "", 40), 0);
});

test("renderPreview does not throw when the canvas context lacks measureText and createLinearGradient (matches Premiere Pro 26.3 UXP)", () => {
  const preset = createDefaultPreset("Test");
  preset.gradient.enabled = true; // exercise the gradient-fallback path too
  preset.backgroundBox.enabled = true;
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "Hello world", start: 0, end: 1 }] });
  const canvas = createStubCanvas(400, 225, { withMeasureText: false, withGradient: false });

  assert.doesNotThrow(() => renderPreview(canvas, preset, chunk));
});

test("renderPreview still works normally when the canvas context has full Canvas 2D support", () => {
  const preset = createDefaultPreset("Test");
  preset.gradient.enabled = true;
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "Hello world", start: 0, end: 1 }] });
  const canvas = createStubCanvas(400, 225, { withMeasureText: true, withGradient: true });

  assert.doesNotThrow(() => renderPreview(canvas, preset, chunk));
});

test("renderPreview handles no chunk (placeholder text) without a canvas context missing measureText", () => {
  const preset = createDefaultPreset("Test");
  const canvas = createStubCanvas(400, 225, { withMeasureText: false, withGradient: false });
  assert.doesNotThrow(() => renderPreview(canvas, preset, undefined));
});

test("renderPreview does not throw when the canvas context also lacks save/restore (matches Premiere Pro 26.3 UXP: \"ctx.save is not a function\")", () => {
  const preset = createDefaultPreset("Test");
  preset.backgroundBox.enabled = true; // exercises the background-box save/restore block
  preset.shadow.enabled = true;
  preset.emphasis.enabled = true; // exercises the per-word save/restore block's font/fillStyle changes
  const chunk = makeChunk({ startSec: 0, endSec: 1, words: [{ text: "hello world", start: 0, end: 1 }] });
  chunk.keywords = ["HELLO"];
  const canvas = createStubCanvas(400, 225, { withMeasureText: false, withGradient: false, withSaveRestore: false });

  assert.doesNotThrow(() => renderPreview(canvas, preset, chunk));
});
