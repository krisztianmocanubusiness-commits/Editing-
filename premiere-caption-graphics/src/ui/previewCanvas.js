/**
 * Renders a canvas approximation of a caption chunk styled with a preset.
 * This is a *preview only* — it's how the editor approves/regenerates
 * styling before anything touches the timeline. The real render in Premiere
 * comes from the .mogrt template, not from this canvas, so treat this as a
 * fast, honest sketch (font/size/weight/color/gradient/box/shadow/blur/
 * tracking/position are all real canvas features; the exact type engine and
 * anti-aliasing will differ from Premiere's).
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
  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, "#3a3a3a");
  bg.addColorStop(1, "#1a1a1a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const text = (chunk?.text || "Your caption text appears here").toUpperCase();
  const keywords = new Set((chunk?.keywords || []).map((k) => k.toUpperCase()));

  const scale = h / 1080; // preset sizes are authored against a 1080-tall reference frame
  const fontSize = preset.font.size * scale;
  const weight = preset.font.weight;
  const tracking = preset.tracking * scale * 0.01;

  ctx.font = `${preset.font.italic ? "italic " : ""}${weight} ${fontSize}px ${preset.font.family}, sans-serif`;
  ctx.textBaseline = "alphabetic";

  const words = text.split(/\s+/);
  const spaceWidth = ctx.measureText(" ").width + tracking;
  const wordWidths = words.map((word) => measureTracked(ctx, word, tracking));
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
    ctx.save();
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
    ctx.restore();
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
    ctx.save();
    if (isEmphasis) {
      ctx.font = `${preset.font.italic ? "italic " : ""}${Math.min(
        preset.font.weight + preset.emphasis.weightBoost,
        900
      )} ${fontSize * preset.emphasis.scale}px ${preset.font.family}, sans-serif`;
    }
    ctx.fillStyle = fillStyleFor(ctx, preset, isEmphasis, x, y, lineWidth, fontSize);
    ctx.globalAlpha = preset.color.opacity / 100;
    drawTracked(ctx, word, cursorX, isEmphasis ? y - (fontSize * (preset.emphasis.scale - 1)) / 2 : y, tracking);
    ctx.restore();
    cursorX += measureTracked(ctx, word, tracking) + spaceWidth;
  }

  ctx.filter = "none";
  ctx.shadowColor = "transparent";
}

function fillStyleFor(ctx, preset, isEmphasis, x, y, lineWidth, fontSize) {
  if (isEmphasis) return preset.emphasis.color;
  if (!preset.gradient.enabled) return preset.color.fill;
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

function measureTracked(ctx, word, tracking) {
  return [...word].reduce((sum, ch) => sum + ctx.measureText(ch).width + tracking, -tracking);
}

function drawTracked(ctx, word, x, y, tracking) {
  let cx = x;
  for (const ch of word) {
    ctx.fillText(ch, cx, y);
    cx += ctx.measureText(ch).width + tracking;
  }
}

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
