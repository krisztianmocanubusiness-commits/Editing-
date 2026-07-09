# Caption Graphics Studio

A Premiere Pro UXP panel that turns a transcript into timed, styled caption
**graphics** on the timeline: select a range, load or paste a transcript,
split it into short caption chunks, auto-detect emphasis words, dial in a
style preset (font, gradient, background box, position, tracking, shadow,
blur, entrance/exit animation, emphasis rules), preview it, and apply it as
real, editable Premiere text layers.

No build step required — it's plain ES modules loaded straight by UXP's
JavaScript engine, the same pattern Adobe uses for its own hand-written
`metadata-handler` sample panel.

## How it works, end to end

```
transcript file / clip transcript
        │  src/transcript/*.js
        ▼
  unified word list (text, start, end)
        │  src/caption/chunker.js   (split on chars/words/duration/pauses/sentences)
        │  src/caption/keywords.js (score + pick emphasis words)
        ▼
  CaptionChunk[]  ──────────────►  live canvas preview (src/ui/previewCanvas.js)
        │                              editor approves / edits / regenerates
        │  src/presets/*.js  (the editable style preset)
        ▼
  src/ppro/applyCaptions.js
        │  insert .mogrt per chunk → trim to chunk duration →
        │  push preset fields into the template's exposed Essential
        │  Graphics parameters → keyframe fallback fade if needed
        ▼
  real Premiere Pro text/graphic clips on the timeline
```

## Setup

1. Install the [UXP Developer Tool](https://developer.adobe.com/uxp/) and Premiere Pro 25.1+.
2. In UDT, "Add Plugin" → point it at this folder's `manifest.json`.
3. Load the plugin into a running Premiere Pro project. The panel appears
   under Window → Extensions → **Caption Graphics Studio**.
4. Author (or license) at least one `.mogrt` matching
   `mogrt-authoring/param-contract.json` — see that folder's README for the
   minimum viable template spec. Point a preset at it via **"Choose
   .mogrt…"** in the panel.

## Validate the host connection first

Before trusting the full pipeline, run the panel's **"0. Host smoke test"**
section: it inserts one `.mogrt`, sets text/font size/fill colour/position/
duration on it, and logs every step's real success/failure to both the
panel and the UXP Developer Tool console — no assumptions, no silent
fallbacks. Full step-by-step instructions and how to read the output:
**[`docs/PREMIERE_HOST_TEST.md`](docs/PREMIERE_HOST_TEST.md)**.

## Using the panel

1. **Transcript** — pull the transcript already attached to the selected
   clip (via Premiere's own Transcript feature), or import a `.srt`, `.vtt`,
   plain `.txt` script, or a Whisper-style word-timed `.json`
   (`sample-data/` has one of each to try the pipeline with).
2. **Timeline range & track** — read the sequence's current in/out points
   (or the full sequence if none are set) and pick a target video track.
   Track *creation* isn't something this extension does automatically
   (see Limitations); use an existing, ideally empty, track above your
   footage.
3. **Split into timed caption chunks** — tune max characters/words per
   chunk, max/min duration, and the pause-gap that forces a break, then
   **Regenerate captions**. Each chunk is independently editable: fix text,
   toggle emphasis, re-run keyword detection, or exclude a chunk entirely.
4. **Style preset** — start from a built-in preset (Bold Pop, Neon Gradient,
   Minimal Clean, Karaoke Line) or your own, and edit every dimension: font
   family/size/weight/italic, fill colour + gradient, background box, safe-
   margin position, tracking, shadow, blur, entrance/exit animation style +
   duration, and emphasis colour/scale/weight. The canvas above updates
   live so you can approve or keep adjusting before anything touches the
   timeline. Presets can be exported/imported as JSON to share across
   projects.
5. **Approve & apply** — once you're happy, apply. Each included chunk
   becomes its own `.mogrt` instance, trimmed to that chunk's exact time
   range, styled from the preset. The log at the bottom reports per-chunk
   success/failure and flags any preset field that had no matching exposed
   parameter on the chosen template.

## Project layout

- `src/transcript/` — format parsers (SRT, VTT, plain text, Whisper JSON,
  Adobe transcript JSON) behind one `parseTranscript()` auto-detector.
- `src/caption/` — `chunker.js` (timing split) and `keywords.js` (emphasis
  scoring heuristic), both pure functions, unit-tested.
- `src/presets/` — the `Preset` schema (`types.js`), built-in library
  (`library.js`), validation/clamping (`validate.js`), and the "authoring
  contract" that maps preset fields to named Essential Graphics parameters
  (`mogrtContract.js`).
- `src/ppro/` — everything that actually talks to Premiere: project/sequence
  access, timeline range read/write, `.mogrt` insertion, component-parameter
  get/set/keyframe, the `applyCaptions.js` orchestrator, and
  `smokeTest.js` (the isolated host-validation pass, see below).
- `src/ui/` — vanilla-JS panel views plus the canvas-based style preview and
  `smokeTestPanel.js`.
- `src/state/store.js` — a ~20-line observable store; no framework.
- `mogrt-authoring/` — the spec for building templates this extension can
  drive, and everything unconfirmed about the live scripting API.
- `docs/PREMIERE_HOST_TEST.md` — manual, in-Premiere validation steps for
  the smoke test panel, including expected log output and a failure triage
  table.
- `test/` — pure-logic unit tests (`node --test`), covering chunking,
  keyword scoring, all transcript parsers, and preset flattening. These run
  without Premiere; the `src/ppro/*` scripting layer cannot be
  unit-tested outside a live host — that's what the smoke test panel and
  `docs/PREMIERE_HOST_TEST.md` are for.

## Running the tests

```
npm test
```

## Known limitations — please read before relying on this in production

This extension is built entirely on the **confirmed, documented** Premiere
Pro UXP scripting surface (verified against Adobe's own `uxp-premiere-pro-samples`
reference panel: `Project`, `Sequence`, `SequenceEditor.insertMogrtFromPath`,
`Component`/`ComponentParam`, `TickTime`, transactions, and the `Transcript`
API). Two real constraints shape the design, and a few specific calls are
flagged as unconfirmed rather than guessed silently:

- **No native "create a styled text layer from scratch" API.** Premiere's
  scripting surface can insert a `.mogrt` and drive whichever parameters its
  author exposed — it can't fabricate a gradient, drop shadow, blur, or
  animation rig on a bare text layer via script. That's why styling flows
  through author-built `.mogrt` templates rather than being generated
  purely in code. See `mogrt-authoring/README.md`.
- **Native Captions are intentionally not used for the graphic itself.**
  As of this writing, Adobe's own docs/community threads describe the
  Caption creation/editing API as still under construction, and native
  captions don't support gradients/box/shadow/blur/custom animation the way
  a `.mogrt` graphic clip does. `sequence.getCaptionTrackCount()` is still
  used read-only for track enumeration.
- **Several call shapes are unconfirmed against a live host**, each isolated
  to a single function and now directly testable via the smoke test panel
  (`src/ppro/smokeTest.js`) rather than just asserted in a comment:
  - Setting a **Source Text** string param and a **Color** param via
    `ComponentParam.createSetValueAction` (`src/ppro/componentParams.js`) —
    Adobe's public sample only demonstrates this call shape for a numeric
    param.
  - A **Position** param's value shape (single Point control vs split X/Y
    sliders vs `{horiz, vert}`) — the smoke test tries three encodings in
    order and reports which one (if any) actually worked.
  - Enumerating a track item's exposed components/params — no explicit
    "count" method appears in the public sample, so `src/ppro/mogrt.js`
    and `smokeTest.js` scan defensively up to a bound instead of an exact
    count.
  - A timeline-start getter on track items (`getStartTime`/`getStart`,
    tried in that order in `src/ppro/transcriptBridge.js`) — used only by
    the "from clip transcript" import path.
  - A playhead/CTI getter on `Sequence` (`getPlayerPosition`/
    `getPlayheadPosition`/`getCurrentTime`, tried in that order in
    `smokeTest.js`) — falls back to the selected range's start time if
    none exist on your host.
- **Track creation isn't automated.** Point the panel at an existing
  (ideally empty) video track; adding a new track programmatically wasn't
  part of the confirmed API surface this was built against.
