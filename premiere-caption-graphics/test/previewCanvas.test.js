import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPreview, measureTextWidth } from "../src/ui/previewCanvas.js";
import { createDefaultPreset } from "../src/presets/types.js";
import { makeChunk } from "../src/caption/types.js";

// Minimal CanvasRenderingContext2D stand-in. `withMeasureText`/`withGradient`
// control whether those two methods exist at all, so tests can simulate
// Premiere Pro 26.3's UXP canvas, which is missing both.
function createStubContext({ withMeasureText = true, withGradient = true } = {}) {
  const ctx = {
    clearRect() {},
    fillRect() {},
    save() {},
    restore() {},
    beginPath() {},
    moveTo() {},
    arcTo() {},
    closePath() {},
    fill() {},
    fillText() {},
  };
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
