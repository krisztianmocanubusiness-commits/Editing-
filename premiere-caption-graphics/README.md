# Caption Graphics Studio

A Premiere Pro UXP panel that turns a transcript into timed, styled caption
**graphics** on the timeline: select a range, load or paste a transcript,
split it into short caption chunks, auto-detect emphasis words, dial in a
style preset (font, gradient, background box, position, tracking, shadow,
blur, entrance/exit animation, emphasis rules), preview it, and apply it as
real, editable Premiere text layers.

Source is written as plain ES modules (readable, no framework), but Premiere
Pro's UXP panel webview does not reliably execute a multi-file
`<script type="module">` graph — confirmed on Premiere Pro 26.3: it produced
a blank panel with zero console output, because `src/main.js` never ran (see
its header comment for the full story). So there **is** a build step: `npm
run build` (esbuild) bundles `src/main.js` and everything it imports into
one plain script, `dist/main.js`, which `index.html` loads via a normal
`<script src="dist/main.js"></script>` — no `import`/`export`, no
`type="module"`, anywhere in what actually ships to the panel. The two real
UXP host modules (`premierepro`, `uxp`) are accessed via literal `require()`
calls that pass straight through the bundle untouched (see
`src/ppro/client.js`), which is UXP's actual, documented module mechanism —
matching Adobe's own `uxp-premiere-pro-samples` reference panel, which is
also TypeScript/ESM source bundled (via Vite) into a single shipped file.

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

1. From this folder (`premiere-caption-graphics/`), run:
   ```
   npm install
   npm run build
   ```
   `npm install` fetches the one build-time dependency (`esbuild`) — nothing
   is required at runtime. `npm run build` produces `dist/main.js`. Re-run
   `npm run build` after every source change (or use `npm run build:watch`
   to rebuild automatically while you edit — leave it running in a separate
   terminal).
2. Install the [UXP Developer Tool](https://developer.adobe.com/uxp/) and Premiere Pro 25.1+.
3. In UDT, **"Add Plugin"** → select **this folder's `manifest.json`**
   (`premiere-caption-graphics/manifest.json`) — not the `dist/` folder,
   not the repo root.
4. Click **Load** (and **Debug**, to see the console) next to the plugin
   entry, with Premiere Pro already running and a project open. The panel
   appears under Window → Extensions → **Caption Graphics Studio**.
5. Author (or license) at least one `.mogrt` matching
   **[`mogrt-contracts/KERIS_CAPTION_V1.md`](mogrt-contracts/KERIS_CAPTION_V1.md)**
   — the first real, buildable contract this extension ships against (10
   required exposed params). Use the panel's **"1. Template Inspector"**
   to check it and save it as your active template (see
   `docs/TEMPLATE_INSPECTOR.md`), or import one of the four ready-made
   presets in `mogrt-contracts/presets/` and fill in its `mogrt.path`
   directly.

If the panel loads but shows only the static header and an empty Log box —
no sections, silence in the console — that's exactly the symptom this build
step fixes; make sure step 1 actually ran and produced `dist/main.js`
(`ls dist/main.js` from this folder should show the file) before reloading
the plugin in UDT.

## Validate the host connection first

Before trusting the full pipeline, run the panel's **"0. Host smoke test"**
section: it inserts one `.mogrt`, sets all 10 `KERIS_CAPTION_V1` fields
(text/font size/fill colour/position/background/tracking/shadow/entrance
style/duration) on it, and logs every step's real success/failure — plus a
strict contract-compliance check naming exactly which required param is
missing, if any — to both the panel and the UXP Developer Tool console. No
assumptions, no silent fallbacks. Full step-by-step instructions and how to
read the output: **[`docs/PREMIERE_HOST_TEST.md`](docs/PREMIERE_HOST_TEST.md)**.

## Using the panel

0. **Host smoke test** — see above; confirms the Premiere connection works
   at all before anything else.
1. **Template Inspector** — pick a `.mogrt`, inspect it against
   `KERIS_CAPTION_V1` (COMPLIANT/NOT COMPLIANT, missing required params,
   extra params, detected contract), and **Save as active template**. This
   is what section 6's apply step uses by default — see
   **[`docs/TEMPLATE_INSPECTOR.md`](docs/TEMPLATE_INSPECTOR.md)**.
2. **Transcript** — pull the transcript already attached to the selected
   clip (via Premiere's own Transcript feature), or import a `.srt`, `.vtt`,
   plain `.txt` script, or a Whisper-style word-timed `.json`
   (`sample-data/` has one of each to try the pipeline with).
3. **Timeline range & track** — read the sequence's current in/out points
   (or the full sequence if none are set) and pick a target video track.
   Track *creation* isn't something this extension does automatically
   (see Limitations); use an existing, ideally empty, track above your
   footage.
4. **Split into timed caption chunks** — tune max characters/words per
   chunk, max/min duration, and the pause-gap that forces a break, then
   **Regenerate captions**. Each chunk is independently editable: fix text,
   toggle emphasis, re-run keyword detection, or exclude a chunk entirely.
5. **Style preset** — start from a built-in preset (Bold Pop, Neon Gradient,
   Minimal Clean, Karaoke Line) or your own, and edit every dimension: font
   family/size/weight/italic, fill colour + gradient, background box, safe-
   margin position, tracking, shadow, blur, entrance/exit animation style +
   duration, and emphasis colour/scale/weight. The canvas above updates
   live so you can approve or keep adjusting before anything touches the
   timeline. Presets can be exported/imported as JSON to share across
   projects. A preset's own `.mogrt` (if set) always wins over the active
   template; leave it unset to use whatever's active.
6. **Approve & apply** — once you're happy, apply. Each included chunk
   becomes its own `.mogrt` instance (the preset's own template, or the
   active template from step 1 if the preset doesn't have one — see
   `docs/TEMPLATE_INSPECTOR.md`), trimmed to that chunk's exact time range,
   styled from the preset. If neither is set, Apply is disabled with an
   explanation of what to do. The log at the bottom reports per-chunk
   success/failure and flags any preset field that had no matching exposed
   parameter on the chosen template.

## Project layout

- `src/transcript/` — format parsers (SRT, VTT, plain text, Whisper JSON,
  Adobe transcript JSON) behind one `parseTranscript()` auto-detector.
- `src/caption/` — `chunker.js` (timing split) and `keywords.js` (emphasis
  scoring heuristic), both pure functions, unit-tested.
- `src/presets/` — the `Preset` schema (`types.js`), built-in library
  (`library.js`), validation/clamping (`validate.js`), the mapping layer
  that resolves preset fields to named Essential Graphics parameters
  (`mogrtContract.js`), the contract-compliance checker
  (`contractValidation.js`), the named-contract registry (`contracts/` —
  currently just `KERIS_CAPTION_V1`), and the active-template fallback
  used at apply-time (`effectiveMogrt.js`).
- `mogrt-contracts/` — `KERIS_CAPTION_V1.md`, the first concrete,
  smoke-test-validated contract (10 required params), plus four ready-to-
  import example presets built for it in `mogrt-contracts/presets/`.
- `src/ppro/` — everything that actually talks to Premiere: project/sequence
  access, timeline range read/write, `.mogrt` insertion, component-parameter
  get/set/keyframe, the `applyCaptions.js` orchestrator, the shared
  component-discovery walk (`introspect.js`), the host-validation pass
  (`smokeTest.js`), and the read-then-clean-up template inspection flow
  (`templateInspector.js`).
- `src/ui/` — vanilla-JS panel views plus the canvas-based style preview,
  `smokeTestPanel.js`, and `templateInspectorPanel.js`.
- `src/state/store.js` — the observable store; no framework. `settings.js`
  persists the "active template" (path + contract id) across panel
  restarts via `localStorage`, with an in-memory fallback if that's not
  available in a given UXP host version.
- `src/main.js` — the panel entrypoint. Authored as an ES module like
  everything else in `src/`, but never loaded directly — see "How it
  works" above and this file's own header comment.
- `dist/main.js` — **build output, not committed** (gitignored). Produced
  by `npm run build`; this is the actual file `index.html` loads.
- `mogrt-authoring/` — the spec for building templates this extension can
  drive, and everything unconfirmed about the live scripting API.
- `docs/PREMIERE_HOST_TEST.md` — manual, in-Premiere validation steps for
  the smoke test panel, including expected log output and a failure triage
  table.
- `docs/TEMPLATE_INSPECTOR.md` — the Template Inspector workflow: how
  inspection works, what "active template" means and where it's stored,
  and how the apply step resolves which `.mogrt` to use.
- `test/` — pure-logic unit tests (`node --test`), covering chunking,
  keyword scoring, all transcript parsers, preset flattening, the
  `KERIS_CAPTION_V1` contract (including that its markdown spec and JS
  definition haven't drifted apart, and that all four example presets
  resolve correctly against it), settings persistence, the active-
  template fallback, and `entrypoint.test.js` (a static regression guard
  making sure `index.html` never goes back to `<script type="module">`
  and always loads `dist/main.js`). These run without Premiere; the
  `src/ppro/*` scripting layer cannot be unit-tested outside a live host —
  that's what the smoke test panel, Template Inspector, and their docs
  are for.

## Running the tests

```
npm install
npm test
```

`npm test` (`node --test`) only exercises the pure-logic modules — it does
not require `npm run build` to have run first.

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
- **`localStorage` availability in a UXP panel is assumed, not confirmed.**
  `src/state/settings.js` (the "active template" persisted by the Template
  Inspector, see `docs/TEMPLATE_INSPECTOR.md`) uses it and falls back to an
  in-memory, session-only value with a logged warning if it throws or
  isn't defined — it won't crash the panel either way, but persistence
  across restarts isn't guaranteed until confirmed on a real host.
