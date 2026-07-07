import { el, field, numberInput, colorInput, checkboxInput, selectInput, rangeInput } from "./components/dom.js";
import { store } from "../state/store.js";
import { BUILT_IN_PRESETS } from "../presets/library.js";
import { clonePreset } from "../presets/types.js";
import { clampPreset } from "../presets/validate.js";
import { renderPreview } from "./previewCanvas.js";
import { getUxp } from "../ppro/client.js";
import { log } from "../util/log.js";

function setPreset(patchFn) {
  store.set((s) => {
    const next = clonePreset(s.activePreset);
    patchFn(next);
    clampPreset(next);
    return { activePreset: next };
  });
}

async function exportPreset() {
  try {
    const uxp = getUxp();
    const preset = store.getState().activePreset;
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving(`${preset.id}.json`, { types: ["json"] });
    if (!file) return;
    await file.write(JSON.stringify(preset, null, 2));
    log(`Preset exported to ${file.nativePath}.`, "success");
  } catch (err) {
    log(`Preset export failed: ${err.message || err}`, "error");
  }
}

async function importPreset() {
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["json"] });
    if (!file) return;
    const content = await file.read();
    const preset = clampPreset(JSON.parse(content));
    store.set({ activePreset: preset });
    log(`Preset imported from ${file.name}.`, "success");
  } catch (err) {
    log(`Preset import failed: ${err.message || err}`, "error");
  }
}

async function pickMogrtFile() {
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["mogrt"] });
    if (!file) return;
    setPreset((p) => {
      p.mogrt.path = file.nativePath;
    });
    log(`Preset now points at ${file.nativePath}`, "success");
  } catch (err) {
    log(`Couldn't pick a .mogrt file: ${err.message || err}`, "error");
  }
}

function section(title, children) {
  return el("div", { class: "preset-section" }, [el("h3", { text: title }), el("div", { class: "options-grid" }, children)]);
}

export function renderPresetPanel(onChange) {
  const state = store.getState();
  const p = state.activePreset;

  const presetSelect = selectInput(
    p.id,
    BUILT_IN_PRESETS.map((bp) => ({ value: bp.id, label: bp.name })),
    (id) => {
      const found = BUILT_IN_PRESETS.find((bp) => bp.id === id);
      if (found) store.set({ activePreset: clonePreset(found) });
      onChange();
    }
  );

  const preview = el("canvas", { width: "400", height: "225", class: "preview-canvas" });

  const chunkForPreview = state.chunks.find((c) => c.id === state.selectedChunkId) || state.chunks[0];
  // Defer to next frame so the canvas is attached to the DOM before we draw.
  requestAnimationFrame(() => renderPreview(preview, p, chunkForPreview));

  const body = el("section", { class: "panel" }, [
    el("h2", { text: "4. Style preset" }),
    el("div", { class: "row" }, [
      el("span", { class: "field-label", text: "Base preset:" }),
      presetSelect,
      el("button", { class: "btn", text: "Choose .mogrt…", onClick: () => pickMogrtFile().then(onChange) }),
      el("button", { class: "btn", text: "Export preset…", onClick: () => exportPreset().then(onChange) }),
      el("button", { class: "btn", text: "Import preset…", onClick: () => importPreset().then(onChange) }),
    ]),
    el("div", { class: "status-line", text: p.mogrt.path ? p.mogrt.path : "No .mogrt selected yet — see mogrt-authoring/README.md" }),

    preview,

    section("Font", [
      field("Family", (() => {
        const input = el("input", { type: "text", value: p.font.family });
        input.addEventListener("input", () => { setPreset((x) => (x.font.family = input.value)); onChange(); });
        return input;
      })()),
      field("Size (px)", numberInput(p.font.size, (v) => { setPreset((x) => (x.font.size = v)); onChange(); }, { min: 8, max: 400 })),
      field("Weight", numberInput(p.font.weight, (v) => { setPreset((x) => (x.font.weight = v)); onChange(); }, { min: 100, max: 900, step: 100 })),
      field("Italic", checkboxInput(p.font.italic, (v) => { setPreset((x) => (x.font.italic = v)); onChange(); })),
    ]),

    section("Colour & gradient", [
      field("Fill colour", colorInput(p.color.fill, (v) => { setPreset((x) => (x.color.fill = v)); onChange(); })),
      field("Opacity %", numberInput(p.color.opacity, (v) => { setPreset((x) => (x.color.opacity = v)); onChange(); }, { min: 0, max: 100 })),
      field("Gradient on", checkboxInput(p.gradient.enabled, (v) => { setPreset((x) => (x.gradient.enabled = v)); onChange(); })),
      field("Gradient angle", numberInput(p.gradient.angleDeg, (v) => { setPreset((x) => (x.gradient.angleDeg = v)); onChange(); }, { min: 0, max: 360 })),
      field("Gradient start", colorInput(p.gradient.stops[0].color, (v) => { setPreset((x) => (x.gradient.stops[0].color = v)); onChange(); })),
      field("Gradient end", colorInput(p.gradient.stops[p.gradient.stops.length - 1].color, (v) => { setPreset((x) => (x.gradient.stops[x.gradient.stops.length - 1].color = v)); onChange(); })),
    ]),

    section("Background box", [
      field("Enabled", checkboxInput(p.backgroundBox.enabled, (v) => { setPreset((x) => (x.backgroundBox.enabled = v)); onChange(); })),
      field("Colour", colorInput(p.backgroundBox.color, (v) => { setPreset((x) => (x.backgroundBox.color = v)); onChange(); })),
      field("Opacity %", numberInput(p.backgroundBox.opacity, (v) => { setPreset((x) => (x.backgroundBox.opacity = v)); onChange(); }, { min: 0, max: 100 })),
      field("Corner radius", numberInput(p.backgroundBox.cornerRadius, (v) => { setPreset((x) => (x.backgroundBox.cornerRadius = v)); onChange(); }, { min: 0, max: 200 })),
      field("Padding X", numberInput(p.backgroundBox.paddingX, (v) => { setPreset((x) => (x.backgroundBox.paddingX = v)); onChange(); }, { min: 0, max: 400 })),
      field("Padding Y", numberInput(p.backgroundBox.paddingY, (v) => { setPreset((x) => (x.backgroundBox.paddingY = v)); onChange(); }, { min: 0, max: 400 })),
    ]),

    section("Position & tracking", [
      field("Vertical", selectInput(p.position.vertical, [
        { value: "top", label: "Top" }, { value: "center", label: "Center" }, { value: "bottom", label: "Bottom" },
      ], (v) => { setPreset((x) => (x.position.vertical = v)); onChange(); })),
      field("Horizontal", selectInput(p.position.horizontal, [
        { value: "left", label: "Left" }, { value: "center", label: "Center" }, { value: "right", label: "Right" },
      ], (v) => { setPreset((x) => (x.position.horizontal = v)); onChange(); })),
      field("Offset X", numberInput(p.position.offsetX, (v) => { setPreset((x) => (x.position.offsetX = v)); onChange(); }, { min: -1000, max: 1000 })),
      field("Offset Y", numberInput(p.position.offsetY, (v) => { setPreset((x) => (x.position.offsetY = v)); onChange(); }, { min: -1000, max: 1000 })),
      field("Safe margin %", numberInput(p.position.safeMarginPct, (v) => { setPreset((x) => (x.position.safeMarginPct = v)); onChange(); }, { min: 0, max: 40 })),
      field("Tracking", numberInput(p.tracking, (v) => { setPreset((x) => (x.tracking = v)); onChange(); }, { min: -200, max: 1000 })),
    ]),

    section("Shadow", [
      field("Enabled", checkboxInput(p.shadow.enabled, (v) => { setPreset((x) => (x.shadow.enabled = v)); onChange(); })),
      field("Colour", colorInput(p.shadow.color, (v) => { setPreset((x) => (x.shadow.color = v)); onChange(); })),
      field("Opacity %", numberInput(p.shadow.opacity, (v) => { setPreset((x) => (x.shadow.opacity = v)); onChange(); }, { min: 0, max: 100 })),
      field("Angle", numberInput(p.shadow.angleDeg, (v) => { setPreset((x) => (x.shadow.angleDeg = v)); onChange(); }, { min: 0, max: 360 })),
      field("Distance", numberInput(p.shadow.distance, (v) => { setPreset((x) => (x.shadow.distance = v)); onChange(); }, { min: 0, max: 200 })),
      field("Softness", numberInput(p.shadow.softness, (v) => { setPreset((x) => (x.shadow.softness = v)); onChange(); }, { min: 0, max: 200 })),
    ]),

    section("Blur", [
      field("Enabled", checkboxInput(p.blur.enabled, (v) => { setPreset((x) => (x.blur.enabled = v)); onChange(); })),
      field("Amount", numberInput(p.blur.amount, (v) => { setPreset((x) => (x.blur.amount = v)); onChange(); }, { min: 0, max: 200 })),
    ]),

    section("Entrance / exit animation", [
      field("Entrance style", selectInput(p.animation.entrance.style, [
        { value: "none", label: "None" }, { value: "fade", label: "Fade" }, { value: "pop", label: "Pop" },
        { value: "slide-up", label: "Slide up" }, { value: "slide-down", label: "Slide down" }, { value: "typewriter", label: "Typewriter" },
      ], (v) => { setPreset((x) => (x.animation.entrance.style = v)); onChange(); })),
      field("Entrance ms", numberInput(p.animation.entrance.durationMs, (v) => { setPreset((x) => (x.animation.entrance.durationMs = v)); onChange(); }, { min: 0, max: 5000, step: 10 })),
      field("Exit style", selectInput(p.animation.exit.style, [
        { value: "none", label: "None" }, { value: "fade", label: "Fade" }, { value: "pop", label: "Pop" },
        { value: "slide-up", label: "Slide up" }, { value: "slide-down", label: "Slide down" },
      ], (v) => { setPreset((x) => (x.animation.exit.style = v)); onChange(); })),
      field("Exit ms", numberInput(p.animation.exit.durationMs, (v) => { setPreset((x) => (x.animation.exit.durationMs = v)); onChange(); }, { min: 0, max: 5000, step: 10 })),
    ]),

    section("Emphasis rules", [
      field("Enabled", checkboxInput(p.emphasis.enabled, (v) => { setPreset((x) => (x.emphasis.enabled = v)); onChange(); })),
      field("Mode", selectInput(p.emphasis.mode, [
        { value: "auto-keywords", label: "Auto (keywords)" }, { value: "manual", label: "Manual only" },
      ], (v) => { setPreset((x) => (x.emphasis.mode = v)); onChange(); })),
      field("Colour", colorInput(p.emphasis.color, (v) => { setPreset((x) => (x.emphasis.color = v)); onChange(); })),
      field("Scale", rangeInput(p.emphasis.scale, (v) => { setPreset((x) => (x.emphasis.scale = v)); onChange(); }, { min: 0.5, max: 2, step: 0.02 })),
      field("Weight boost", numberInput(p.emphasis.weightBoost, (v) => { setPreset((x) => (x.emphasis.weightBoost = v)); onChange(); }, { min: 0, max: 500, step: 50 })),
    ]),
  ]);

  return body;
}
