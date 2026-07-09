# Authoring `.mogrt` templates for Caption Graphics Studio

This is the generic, unconstrained spec — every style field the preset
schema supports, with no fixed required subset. For the first concrete,
buildable, smoke-test-validated contract (10 required params, no
per-word emphasis, split Position X/Y), see
**[`/mogrt-contracts/KERIS_CAPTION_V1.md`](../mogrt-contracts/KERIS_CAPTION_V1.md)**
instead — that's what `src/ppro/smokeTest.js` checks against by default and
what the four example presets in `mogrt-contracts/presets/` are built for.
Start there; come back here only if you need a param this extension
supports but KERIS_CAPTION_V1 doesn't require (gradient, blur, per-word
emphasis, exit animation, background corner radius/padding, shadow
angle/distance/softness).

## Why templates, not generated text

Premiere Pro's public UXP scripting API lets an extension **insert** a Motion
Graphics Template and **read/write whichever properties the template author
exposed** in the Essential Graphics panel. It does not let a script fabricate
a new text layer, drop shadow, gradient, or animation rig from nothing — that
authoring still happens once, by hand, in After Effects (or Premiere's own
Essential Graphics panel), and gets exported as a `.mogrt`.

So this extension's "editable graphic presets" work in two halves:

1. **The preset** (`src/presets/types.js`) — a plain JS object describing
   font, color, gradient, background box, position, tracking, shadow, blur,
   entrance/exit animation, and emphasis rules. This is what the editor edits
   and previews live in the panel.
2. **The `.mogrt`** — an After Effects-authored template whose Essential
   Graphics controls are named to match `param-contract.json` in this folder.
   At apply-time, the extension pushes each preset field into whichever of
   these named controls the chosen template actually exposes (see
   `src/presets/mogrtContract.js` / `src/ppro/applyCaptions.js`).

A preset and a template are matched by **name**, not position, and a preset
can remap names per-template via `preset.mogrt.paramMap` if you'd rather use
your own naming convention.

## Minimum viable template

To support a preset end-to-end, build an AE comp with:

- One text layer, Source Text exposed as **"Caption Text"**.
- A Fill effect or the text's native fill exposed as **"Fill Color"**.
- A background shape layer (rounded rect) with opacity/fill controls
  exposed as **"Background Enabled"** / **"Background Color"** / etc. (can
  be 0-opacity by default if you don't want it visible without the box).
- A Drop Shadow layer style with distance/softness/opacity exposed.
- A single integer slider **"Animation Style"** (0-5) that an expression on
  each animatable property (position, opacity, scale) reads to pick between
  a handful of pre-built entrance/exit rigs (fade, pop, slide-up, slide-down,
  typewriter). Time-remap or expression-drive these off layer duration so
  they hold correctly regardless of how long the extension trims the clip to.
- Optionally, a second small text layer **"Emphasis Word"** if you want
  emphasis rendered as a separate highlight overlay instead of recoloring
  words inline within Caption Text.

Export via Graphics panel context menu → **Export as Motion Graphics
Template...** and note the saved path — that's what goes into a preset's
`mogrt.path`.

## What happens if a control is missing

`applyChunkToTimeline()` in `src/ppro/applyCaptions.js` looks up every param
the active preset wants; anything not found on a given `.mogrt` is skipped
and reported back to the panel log rather than throwing, so a minimal
template (just Caption Text + Fill Color) still works, just with fewer style
dimensions actually landing on the timeline. The one exception: if
`Animation Style` is missing, the extension synthesizes a basic opacity
fade in/out using `Fill Opacity` as a fallback so entrance/exit isn't silently
dropped.

## Things to verify in your environment before relying on this

The Premiere Pro UXP `ComponentParam` API is confirmed (via Adobe's own
sample panel) for numeric effect parameters. This project also uses the same
`createKeyframe`/`createSetValueAction` call shape for **color objects** and
**Source Text strings**, which Adobe's public sample does not demonstrate.
If your installed Premiere version rejects either:

- Color: adjust `hexToColorObject`/`coerceValue` in
  `src/ppro/componentParams.js` to match whatever shape your host's Color
  Control param actually accepts.
- Source Text: some hosts may need a direct `param.setValue(text)` instead
  of the keyframe indirection — that's isolated to `setParamValue()` in the
  same file.

Also verify `findExposedParam`'s component/param enumeration bounds in
`src/ppro/mogrt.js` against the real `@adobe/premierepro` TypeScript
declarations installed in your dev environment (look for an explicit
`getComponentCount()`/`getParamCount()` and swap it in if present — the
current code defensively scans up to 64 indices instead).

Native Premiere **Captions** (the built-in closed-caption track type) were
deliberately not used for the styled graphic itself: as of this writing
Adobe's own docs/samples mark the caption creation/editing API as still
under construction, and native captions don't support gradients, background
box + shadow + blur, or custom entrance/exit animation the way a `.mogrt`
graphic clip does. `sequence.getCaptionTrack()` is still used read-only if
you want to *also* generate real closed captions from the same transcript
alongside the graphics — see `src/ppro/timelineRange.js` `listVideoTracks`
for the analogous video-track pattern to extend if you build that out.
