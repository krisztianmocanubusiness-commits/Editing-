# MOGRT Contract: KERIS_CAPTION_V1

Status: **first shipped contract**. This is the concrete, buildable spec the
smoke test (`src/ppro/smokeTest.js`) validates against by default, and the
one the four example presets in `mogrt-contracts/presets/` are authored for.

This document and `src/presets/contracts/kerisCaptionV1.js` must always
agree — the JS file is the source of truth the code resolves against, this
file is what a motion designer reads to build a compliant `.mogrt`. A guard
test (`test/contracts.test.js`) checks the two don't drift apart.

## What this contract is for

A single-line, whole-chunk styled subtitle graphic: one caption chunk in,
one styled text-on-background graphic out. **V1 does not support inline
per-word emphasis** (recoloring one word inside a longer line) — that would
need a second exposed text layer/param set this contract doesn't define
yet. Instead, V1 achieves emphasis at the *preset* level: build the whole
chunk as its own instance using a preset like "Yellow Impact Word" when you
want that chunk to read as emphasized. See the four example presets for
what that looks like in practice.

## Required exposed params

Every param below **must** be exposed (checked "Expose" in the Essential
Graphics panel, verbatim display name, before export) for a `.mogrt` to be
`KERIS_CAPTION_V1`-compliant. The smoke test's contract-compliance check
(step 8 in its log output) fails on any missing name here — no aliasing,
no guessing.

| # | Display name (exact) | Essential Graphics control type | Preset field it drives | Notes |
|---|---|---|---|---|
| 1 | `Text` | Source Text | `mogrt.captionText` (chunk text) | The caption line itself. |
| 2 | `Font Size` | Slider | `font.size` | Authored in px at a 1080-tall reference frame. |
| 3 | `Fill Color` | Color Control | `color.fill` | Text fill colour. |
| 4 | `Position X` | Slider | `position.offsetX` | Plain number, **not** a Point control — see "Why split X/Y" below. |
| 5 | `Position Y` | Slider | `position.offsetY` | Plain number. |
| 6 | `Background Opacity` | Slider (0-100) | `backgroundBox.opacity` | 0 = card invisible; template should still render at 0 without erroring. |
| 7 | `Background Color` | Color Control | `backgroundBox.color` | Card fill colour, independent of its opacity. |
| 8 | `Tracking` | Slider | `tracking` | Maps to the Character panel's Tracking value. |
| 9 | `Shadow Opacity` | Slider (0-100) | `shadow.opacity` | Drives a Drop Shadow layer style's opacity; 0 = no visible shadow. |
| 10 | `Entrance Style` | Slider (integer 0-5) | `animation.entrance.style` | `0`=none `1`=fade `2`=pop `3`=slide-up `4`=slide-down `5`=typewriter. Drives which pre-built entrance rig plays via expression selection on the animatable properties (position/opacity/scale). |

### Why split Position X / Position Y, not a single Point control

Earlier, pre-contract smoke tests against ad-hoc templates showed a single
"Position" Point control's real scripted value shape (array vs `{x,y}` vs
`{horiz,vert}`) is unconfirmed and host-dependent. Two plain number sliders
sidestep that entirely — `setParamValue()` already has a confirmed, working
path for numeric params (see `src/ppro/componentParams.js`). Every contract
from V1 onward should prefer split numeric controls over a compound
control wherever possible, for the same reason.

## What's deliberately *not* required by V1

- Gradient fill, blur, drop-shadow angle/distance/softness (only opacity),
  background corner radius/padding, exit animation, and per-word emphasis
  are all part of the generic preset schema (`src/presets/types.js`) and
  the generic fallback param names (`CANONICAL_PARAMS` in
  `src/presets/mogrtContract.js`), but none of them are required by this
  contract. A `.mogrt` may expose them anyway (the generic fallback will
  pick them up by name automatically), but the smoke test and the
  compliance check only ever require the 10 params above.

## Building a compliant template

1. In After Effects (or Premiere's own Graphics → New Layer → Text), build
   one comp with: a text layer, a rounded-rect background shape behind it,
   and a Drop Shadow layer style on the text.
2. Wire an integer slider control ("Entrance Style", 0-5) to an expression
   on the text/background layers' Position, Opacity, and Scale that
   selects between a handful of pre-built keyframed rigs (fade, pop,
   slide-up, slide-down, typewriter) baked at authoring time. Time-remap
   or duration-relative-express these so they still look right regardless
   of how long the extension trims the clip to.
3. In the Essential Graphics panel, drag in exactly these controls, in any
   order, named **exactly** as in the table above (case- and
   space-sensitive — `resolveParamName()` does an exact string match):
   `Text`, `Font Size`, `Fill Color`, `Position X`, `Position Y`,
   `Background Opacity`, `Background Color`, `Tracking`, `Shadow Opacity`,
   `Entrance Style`.
4. Export via **Export as Motion Graphics Template…**.
5. Validate it: open the panel's smoke test section, pick the exported
   `.mogrt`, click **Run Smoke Test**, and read the "KERIS_CAPTION_V1:
   COMPLIANT / NOT COMPLIANT" line. If NOT COMPLIANT, it lists exactly
   which of the 10 names above weren't found — go back to the Essential
   Graphics panel, fix the naming/exposure, re-export, re-run. See
   `docs/PREMIERE_HOST_TEST.md` for the full manual procedure.

## Binding a preset to this contract

A `Preset` (see `src/presets/types.js`) opts into this contract by setting:

```json
{
  "mogrt": {
    "path": "/absolute/path/to/your/exported.mogrt",
    "contractId": "KERIS_CAPTION_V1",
    "paramMap": {}
  }
}
```

`resolveParamName()` in `src/presets/mogrtContract.js` then resolves each
preset field to a param name in this priority order:

1. `preset.mogrt.paramMap[fieldKey]` — an explicit per-preset override, for
   a one-off template that uses different names than the contract.
2. `KERIS_CAPTION_V1.paramMap[fieldKey]` (this contract) — the default for
   any preset with `contractId: "KERIS_CAPTION_V1"`.
3. `CANONICAL_PARAMS[fieldKey]` — the generic, contract-agnostic fallback,
   used when `contractId` is unset.

This is why a preset only needs `contractId` set, not a hand-written
`paramMap` for all ten fields — see `mogrt-contracts/presets/` for four
presets that do exactly this.

## Example presets

`mogrt-contracts/presets/` ships four ready-to-import `Preset` JSON files
(load via the panel's **"Import preset…"** button), each bound to this
contract:

- **`white-clean-subtitle.json`** — plain white body-copy subtitle, no
  background card, light shadow.
- **`blue-keyword.json`** — bold blue whole-line treatment for a
  keyword-carrying chunk.
- **`yellow-impact-word.json`** — large, bold, yellow, wide-tracking — for
  a single high-impact word/short chunk.
- **`beige-background-card.json`** — dark text on a solid beige background
  card, exercising `Background Opacity`/`Background Color`.

Each still needs its `mogrt.path` filled in to point at your own exported
`.mogrt` — they're style data, not a bundled binary template.
