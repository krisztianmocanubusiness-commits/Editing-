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

// Strip comments before scanning so a doc comment that *mentions* a method
// name (e.g. explaining why it's deliberately not called) isn't itself
// treated as a usage. Good enough for this codebase's actual content, not
// meant to be a full JS parser.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function findCanvasContextCalls(source) {
  return [...stripComments(source).matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
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

/**
 * "Is this a real method name" (the test above) isn't the whole story:
 * `ctx.measureText` is a perfectly real, standard Canvas 2D member, and it
 * still threw `TypeError: ctx.measureText is not a function` in Premiere
 * Pro 26.3, because that host's UXP canvas implementation simply doesn't
 * have it. So this second check goes further: for members known to be
 * missing or inconsistent across real hosts (confirmed: measureText;
 * flagged as worth checking: gradients, roundRect, setTransform/
 * resetTransform, filter), it requires that every file using one of them
 * also contains a feature-detection guard (`typeof ctx.<member> ===
 * "function"` or `"<member>" in ctx`) somewhere in that file.
 *
 * This is a whole-file check, not a per-call-site one — it can't prove
 * the *specific* call is inside the guarded branch, only that the file
 * demonstrates it's aware the member might be missing. That's a
 * deliberate simplicity/robustness tradeoff (no real JS parser involved),
 * and it's exactly the check that would have failed on the original,
 * unguarded `ctx.measureText(text).width` calls before this fix.
 */
const RISKY_CANVAS_2D_MEMBERS = [
  "measureText",
  "createLinearGradient",
  "createRadialGradient",
  "createConicGradient",
  "roundRect",
  "setTransform",
  "resetTransform",
  "filter",
];

function hasAvailabilityGuard(source, member) {
  const typeofGuard = new RegExp(`typeof\\s+ctx\\.${member}\\s*(===|!==)\\s*["']function["']`);
  const inGuard = new RegExp(`["']${member}["']\\s+in\\s+ctx\\b`);
  return typeofGuard.test(source) || inGuard.test(source);
}

test("risky Canvas 2D members (not guaranteed to exist on every UXP host) are feature-detected before use", () => {
  const problems = [];
  for (const file of listJsFiles(SRC_DIR)) {
    const source = stripComments(fs.readFileSync(file, "utf8"));
    const usedMembers = new Set(findCanvasContextCalls(source));
    for (const member of RISKY_CANVAS_2D_MEMBERS) {
      if (usedMembers.has(member) && !hasAvailabilityGuard(source, member)) {
        problems.push(
          `${path.relative(SRC_DIR, file)}: ctx.${member} is used but no ` +
            `'typeof ctx.${member} === "function"' or '"${member}" in ctx' guard was found in that file`
        );
      }
    }
  }
  assert.deepEqual(
    problems,
    [],
    `Found unguarded use of a Canvas 2D member known to be missing/inconsistent across hosts:\n${problems.join("\n")}`
  );
});
