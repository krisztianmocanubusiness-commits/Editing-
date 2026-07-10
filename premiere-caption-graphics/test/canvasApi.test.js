import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, "../src");

/**
 * Regression guard for calling a nonexistent CanvasRenderingContext2D
 * member (property or method) — e.g. `ctx.restoreText(...)`, which is not
 * a real Canvas API and would only be caught previously by actually
 * running the panel in a browser/UXP host and watching it throw. This
 * statically scans every `ctx.<name>` usage across src/ and checks it
 * against the real 2D context API surface, so a typo like that fails
 * `npm test` instead of shipping.
 *
 * Kept as a curated allowlist rather than instantiating a real
 * CanvasRenderingContext2D (e.g. via the `canvas` npm package), since that
 * needs native compilation this project has no other use for — the
 * panel's actual canvas comes from the UXP/Chromium webview at runtime,
 * not from Node.
 */
const VALID_CANVAS_2D_MEMBERS = new Set([
  // state
  "save", "restore", "reset",
  // transform
  "scale", "rotate", "translate", "transform", "setTransform", "resetTransform", "getTransform",
  // compositing
  "globalAlpha", "globalCompositeOperation",
  // colors and styles
  "fillStyle", "strokeStyle",
  "createLinearGradient", "createRadialGradient", "createConicGradient", "createPattern",
  // line styles
  "lineWidth", "lineCap", "lineJoin", "miterLimit", "getLineDash", "setLineDash", "lineDashOffset",
  // shadows
  "shadowOffsetX", "shadowOffsetY", "shadowBlur", "shadowColor",
  // rects
  "clearRect", "fillRect", "strokeRect",
  // path
  "beginPath", "closePath", "moveTo", "lineTo", "bezierCurveTo", "quadraticCurveTo",
  "arc", "arcTo", "ellipse", "rect", "roundRect",
  "fill", "stroke", "clip", "isPointInPath", "isPointInStroke",
  // text
  "font", "textAlign", "textBaseline", "direction", "fontKerning", "fontStretch", "fontVariantCaps",
  "letterSpacing", "wordSpacing", "textRendering",
  "fillText", "strokeText", "measureText",
  // drawing images
  "drawImage",
  // pixel manipulation
  "createImageData", "getImageData", "putImageData",
  // image smoothing
  "imageSmoothingEnabled", "imageSmoothingQuality",
  // filters
  "filter",
  // misc
  "canvas", "getContextAttributes", "drawFocusIfNeeded",
]);

function findCanvasContextCalls(source) {
  return [...source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("every ctx.<member> usage in src/ is a real CanvasRenderingContext2D member", () => {
  const offenders = [];
  for (const file of listJsFiles(SRC_DIR)) {
    const source = fs.readFileSync(file, "utf8");
    for (const member of findCanvasContextCalls(source)) {
      if (!VALID_CANVAS_2D_MEMBERS.has(member)) {
        offenders.push(`${path.relative(SRC_DIR, file)}: ctx.${member}`);
      }
    }
  }
  assert.deepEqual(offenders, [], `Found call(s) to a nonexistent Canvas 2D context member:\n${offenders.join("\n")}`);
});

test("src/ui/previewCanvas.js is the only file that references a canvas context (sanity check for this test's scope)", () => {
  const filesUsingCtx = listJsFiles(SRC_DIR).filter((file) => /\bctx\b/.test(fs.readFileSync(file, "utf8")));
  assert.deepEqual(
    filesUsingCtx.map((f) => path.relative(SRC_DIR, f)),
    ["ui/previewCanvas.js"]
  );
});
