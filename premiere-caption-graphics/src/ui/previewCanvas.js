/**
 * Renders a canvas approximation of a caption chunk styled with a preset.
 * This is a *preview only* — it's how the editor approves/regenerates
 * styling before anything touches the timeline. The real render in Premiere
 * comes from the .mogrt template, not from this canvas, so treat this as a
 * fast, honest sketch (font/size/weight/color/gradient/box/shadow/blur/
 * tracking/position are all real canvas features; the exact type engine and
 * anti-aliasing will differ from Premiere's).
 *
 * UXP host note: Premiere Pro 26.3's UXP canvas implementation does not
 * expose the full browser Canvas 2D API — confirmed missing: `measureText`
 * (`ctx.measureText is not a function`) and `save`/`restore`
 * (`ctx.save is not a function`), both thrown from this file against a real
 * host. This module now feature-detects every non-guaranteed Canvas 2D
 * member it uses (measureText, createLinearGradient, save/restore; `filter`
 * was already guarded) and falls back to a deterministic approximation (or,
 * for save/restore, manual property snapshot/restore via ctxSave()/
 * ctxRestore() below) instead of crashing. `ctx.roundRect()`/
 * `ctx.setTransform()`/`ctx.resetTransform()` are not called anywhere in
 * this file (the background box uses a local `roundRect()` helper built
 * from beginPath/moveTo/arcTo instead of the native method) — see
 * test/canvasApi.test.js for the regression guard that keeps all of this
 * true.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {import("../presets/types.js").Preset} preset
 * @param {import("../caption/types.js").CaptionChunk} [chunk]
 */
export function renderPreview(canvas, preset, chunk) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // Fake video background so light-on-dark / dark-on-light both preview sensibly.
  ctx.fillStyle = backgroundFill(ctx, h);
  ctx.fillRect(0, 0, w, h);

  const text = (chunk?.text || "Your caption text appears here").toUpperCase();
  const keywords = new Set((chunk?.keywords || []).map((k) => k.toUpperCase()));

  const scale = h / 1080; // preset sizes are authored against a 1080-tall reference frame
  const fontSize = preset.font.size * scale;
  const weight = preset.font.weight;
  const tracking = preset.tracking * scale * 0.01;
  const family = preset.font.family;

  ctx.font = `${preset.font.italic ? "italic " : ""}${weight} ${fontSize}px ${family}, sans-serif`;
  ctx.textBaseline = "alphabetic";

  const words = text.split(/\s+/);
  const spaceWidth = measureTextWidth(ctx, " ", fontSize, weight, family) + tracking;
  const wordWidths = words.map((word) => measureTracked(ctx, word, tracking, fontSize, weight, family));
  const lineWidth = wordWidths.reduce((a, b) => a + b, 0) + spaceWidth * (words.length - 1);

  const marginPx = (preset.position.safeMarginPct / 100) * Math.min(w, h);
  let x;
  if (preset.position.horizontal === "left") x = marginPx;
  else if (preset.position.horizontal === "right") x = w - marginPx - lineWidth;
  else x = (w - lineWidth) / 2;
  x += preset.position.offsetX * scale;

  let y;
  if (preset.position.vertical === "top") y = marginPx + fontSize;
  else if (preset.position.vertical === "center") y = h / 2 + fontSize / 2;
  else y = h - marginPx;
  y += preset.position.offsetY * scale;

  if (preset.backgroundBox.enabled) {
    const padX = preset.backgroundBox.paddingX * scale;
    const padY = preset.backgroundBox.paddingY * scale;
    const savedState = ctxSave(ctx);
    ctx.globalAlpha = preset.backgroundBox.opacity / 100;
    ctx.fillStyle = preset.backgroundBox.color;
    roundRect(
      ctx,
      x - padX,
      y - fontSize - padY * 0.3,
      lineWidth + padX * 2,
      fontSize + padY * 1.3,
      preset.backgroundBox.cornerRadius * scale
    );
    ctx.fill();
    ctxRestore(ctx, savedState);
  }

  if (preset.blur.enabled && "filter" in ctx) {
    ctx.filter = `blur(${preset.blur.amount * scale}px)`;
  }

  if (preset.shadow.enabled) {
    ctx.shadowColor = withAlpha(preset.shadow.color, preset.shadow.opacity / 100);
    const rad = (preset.shadow.angleDeg * Math.PI) / 180;
    ctx.shadowOffsetX = Math.cos(rad) * preset.shadow.distance * scale;
    ctx.shadowOffsetY = Math.sin(rad) * preset.shadow.distance * scale;
    ctx.shadowBlur = preset.shadow.softness * scale;
  }

  let cursorX = x;
  for (const word of words) {
    const isEmphasis = preset.emphasis.enabled && keywords.has(word);
    const savedWordState = ctxSave(ctx);
    const wordFontSize = isEmphasis ? fontSize * preset.emphasis.scale : fontSize;
    const wordWeight = isEmphasis ? Math.min(preset.font.weight + preset.emphasis.weightBoost, 900) : weight;
    if (isEmphasis) {
      ctx.font = `${preset.font.italic ? "italic " : ""}${wordWeight} ${wordFontSize}px ${family}, sans-serif`;
    }
    ctx.fillStyle = fillStyleFor(ctx, preset, isEmphasis, x, y, lineWidth, fontSize);
    ctx.globalAlpha = preset.color.opacity / 100;
    drawTracked(
      ctx,
      word,
      cursorX,
      isEmphasis ? y - (fontSize * (preset.emphasis.scale - 1)) / 2 : y,
      tracking,
      wordFontSize,
      wordWeight,
      family
    );
    ctxRestore(ctx, savedWordState);
    cursorX += measureTracked(ctx, word, tracking, fontSize, weight, family) + spaceWidth;
  }

  if ("filter" in ctx) ctx.filter = "none";
  ctx.shadowColor = "transparent";
}

// ---------------------------------------------------------------------------
// Host-availability-safe helpers. See the module doc comment above: these
// exist because Premiere Pro 26.3's UXP canvas doesn't implement the full
// browser Canvas 2D API, and this preview must degrade instead of crash.
// ---------------------------------------------------------------------------

const warnedOnce = new Set();

function warnOnce(key, message) {
  if (warnedOnce.has(key)) return;
  warnedOnce.add(key);
  console.warn(message);
}

// Canvas 2D state properties this file mutates inside a save/restore-guarded
// block. Used only as the manual-snapshot fallback below — a fixed, slightly
// generous list rather than trying to detect exactly which properties a
// given block touches, so a future edit inside one of those blocks can't
// silently start leaking unrestored state.
const TRACKED_CTX_STATE_PROPS = [
  "fillStyle",
  "strokeStyle",
  "globalAlpha",
  "font",
  "textBaseline",
  "shadowColor",
  "shadowOffsetX",
  "shadowOffsetY",
  "shadowBlur",
  "filter",
];

// Sentinel returned by ctxSave() when the host's real save()/restore() were
// used, so ctxRestore() knows which path to take without re-probing.
const REAL_SAVE_RESTORE = Symbol("real-save-restore");

/**
 * Safe stand-in for `ctx.save()`. Uses the real method only when BOTH
 * `save` and `restore` are functions (calling one without the other would
 * corrupt state, not preserve it); otherwise manually snapshots the state
 * properties this file cares about and returns them for ctxRestore() to
 * reapply. Never throws.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @returns {typeof REAL_SAVE_RESTORE | Record<string, *>}
 */
export function ctxSave(ctx) {
  if (typeof ctx.save === "function" && typeof ctx.restore === "function") {
    ctx.save();
    return REAL_SAVE_RESTORE;
  }
  warnOnce(
    "save-restore",
    "[Caption Graphics Studio] canvas save/restore unavailable; manually preserving state"
  );
  const snapshot = {};
  for (const prop of TRACKED_CTX_STATE_PROPS) {
    if (prop in ctx) snapshot[prop] = ctx[prop];
  }
  return snapshot;
}

/**
 * Pairs with ctxSave(): calls the real `ctx.restore()` if that's what was
 * used, otherwise manually reapplies the snapshotted properties. Tolerates
 * a host rejecting a given property write (e.g. a read-only member) instead
 * of throwing.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {typeof REAL_SAVE_RESTORE | Record<string, *>} saved
 */
export function ctxRestore(ctx, saved) {
  if (saved === REAL_SAVE_RESTORE) {
    if (typeof ctx.restore === "function") ctx.restore();
    return;
  }
  for (const [prop, value] of Object.entries(saved)) {
    try {
      ctx[prop] = value;
    } catch {
      // Read-only or unsupported property on this host — nothing more we can do.
    }
  }
}

// Coarse per-character width table, used only when ctx.measureText() isn't
// available. Good enough for centering text and sizing a background box in
// a *preview*, not meant to be typographically precise.
const NARROW_CHARS = new Set([" ", ".", ",", "'", '"', "!", "|", ":", ";", "i", "j", "l", "I"]);
const WIDE_CHARS = new Set(["m", "w", "M", "W", "@", "%", "G", "O", "Q"]);

function approximateCharWidth(ch, fontSizePx, fontWeight, isMonospace) {
  if (isMonospace) return 0.6 * fontSizePx;

  let factor = 0.52; // average glyph width as a fraction of font size, typical sans-serif
  if (NARROW_CHARS.has(ch)) factor = 0.26;
  else if (WIDE_CHARS.has(ch)) factor = 0.86;
  else if (/[A-Z]/.test(ch)) factor = 0.64;
  else if (/[0-9]/.test(ch)) factor = 0.56;

  if (fontWeight >= 700) factor *= 1.08; // bold glyphs run a little wider

  return factor * fontSizePx;
}

function approximateTextWidth(text, fontSizePx, fontWeight, fontFamily) {
  const isMonospace = /mono/i.test(fontFamily || "");
  let total = 0;
  for (const ch of text) total += approximateCharWidth(ch, fontSizePx, fontWeight, isMonospace);
  return total;
}

/**
 * Safe stand-in for `ctx.measureText(text).width`. Uses the real method
 * when the host provides it; otherwise falls back to a deterministic
 * character-count/font-size approximation rather than throwing.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text
 * @param {number} fontSizePx
 * @param {number} [fontWeight]
 * @param {string} [fontFamily]
 */
export function measureTextWidth(ctx, text, fontSizePx, fontWeight = 400, fontFamily = "") {
  if (typeof ctx.measureText === "function") {
    return ctx.measureText(text).width;
  }
  warnOnce("measureText", "[Caption Graphics Studio] canvas measureText unavailable; using width approximation");
  return approximateTextWidth(text, fontSizePx, fontWeight, fontFamily);
}

function measureTracked(ctx, word, tracking, fontSizePx, fontWeight, fontFamily) {
  return [...word].reduce(
    (sum, ch) => sum + measureTextWidth(ctx, ch, fontSizePx, fontWeight, fontFamily) + tracking,
    -tracking
  );
}

function drawTracked(ctx, word, x, y, tracking, fontSizePx, fontWeight, fontFamily) {
  let cx = x;
  for (const ch of word) {
    ctx.fillText(ch, cx, y);
    cx += measureTextWidth(ctx, ch, fontSizePx, fontWeight, fontFamily) + tracking;
  }
}

/** Background gradient, or a flat fallback colour if createLinearGradient isn't available. */
function backgroundFill(ctx, h) {
  if (typeof ctx.createLinearGradient !== "function") {
    warnOnce(
      "createLinearGradient",
      "[Caption Graphics Studio] canvas createLinearGradient unavailable; using flat colour fallback"
    );
    return "#28282a";
  }
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#3a3a3a");
  bg.addColorStop(1, "#1a1a1a");
  return bg;
}

function fillStyleFor(ctx, preset, isEmphasis, x, y, lineWidth, fontSize) {
  if (isEmphasis) return preset.emphasis.color;
  if (!preset.gradient.enabled) return preset.color.fill;

  if (typeof ctx.createLinearGradient !== "function") {
    warnOnce(
      "createLinearGradient",
      "[Caption Graphics Studio] canvas createLinearGradient unavailable; using flat colour fallback"
    );
    return preset.gradient.stops[0]?.color ?? preset.color.fill;
  }

  const rad = (preset.gradient.angleDeg * Math.PI) / 180;
  const gradient = ctx.createLinearGradient(
    x - Math.cos(rad) * lineWidth,
    y - Math.sin(rad) * fontSize,
    x + Math.cos(rad) * lineWidth,
    y + Math.sin(rad) * fontSize
  );
  for (const stop of preset.gradient.stops) {
    gradient.addColorStop(stop.position / 100, stop.color);
  }
  return gradient;
}

// Local rounded-rect path builder — deliberately not `ctx.roundRect()`,
// which isn't part of every Canvas 2D implementation. Built entirely from
// beginPath/moveTo/arcTo/closePath, which are.
function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function withAlpha(hex, alpha) {
  const clean = hex.replace("#", "");
  const full = clean.length === 3 ? clean.split("").map((c) => c + c).join("") : clean;
  const num = parseInt(full, 16);
  const r = (num >> 16) & 255;
  const g = (num >> 8) & 255;
  const b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
