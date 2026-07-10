# MOGRT Contract: KERIS_CAPTION_V1

Status: **the fuller, After-Effects-authored contract.** Requires split
`Position X`/`Position Y` and a baked `Entrance Style` animation-selector
rig — neither of which Premiere's native graphics can produce (confirmed —
see `mogrt-authoring/PREMIERE_ONLY_GUIDE.md`). If you're authoring in
**Premiere alone, with no After Effects**, use
**[`KERIS_CAPTION_V1_PPRO`](../mogrt-authoring/PREMIERE_ONLY_GUIDE.md)**
instead — it's the recommended/default contract this extension's smoke
test and Template Inspector check against, and the one the four example
presets in `mogrt-contracts/presets/` are now authored for. This document
stays fully supported for anyone building the richer AE version.

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
`KERIS_CAPTION_V1`-compliant. The contract-compliance check (see
`validateAgainstContract()` in `src/presets/contractValidation.js`) fails
on any missing name here — no aliasing, no guessing. Note that
`src/ppro/smokeTest.js` and the Template Inspector now check against
`KERIS_CAPTION_V1_PPRO` **by default**, not this contract — to check a
template against this fuller contract instead, pass `contract:
KERIS_CAPTION_V1` explicitly (see that file's JSDoc), or just read the
Template Inspector's "Detected contract" line, which always checks the
whole registry regardless of which one is the default target.

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

Two plain number sliders sidestep a real problem: a single "Position"
Point control's scripted value shape (array vs `{x,y}` vs `{horiz,vert}`)
is unconfirmed and host-dependent (see `setPointParamValue()` in
`src/ppro/componentParams.js`, which has to try all three), whereas
`setParamValue()` has a confirmed, working path for plain numeric params.
**However**, splitting Position this way turns out to only be buildable in
After Effects — Premiere's native graphics don't support "Separate
Dimensions" on Position at all (confirmed, see
`mogrt-authoring/PREMIERE_ONLY_GUIDE.md`). So this is a real tradeoff, not
a strictly-better choice: `KERIS_CAPTION_V1` (this contract) takes the
split-and-more-reliable-to-script path, at the cost of requiring After
Effects; `KERIS_CAPTION_V1_PPRO` takes the combined-and-Premiere-buildable
path, at the cost of a less certain value encoding.

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

This contract requires After Effects — split `Position X`/`Position Y`
and a baked `Entrance Style` rig are both architecturally unavailable in
Premiere's native graphics (confirmed; see
`mogrt-authoring/PREMIERE_ONLY_GUIDE.md` for the research). If you don't
have After Effects, build against `KERIS_CAPTION_V1_PPRO` instead — same
guide covers that end to end.

1. In After Effects, build one comp with: a text layer, a rounded-rect
   background shape behind it, and a Drop Shadow layer style on the text.
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
5. Validate it: open the panel's **"1. Template Inspector"** section, pick
   the exported `.mogrt`, click **Inspect Template**, and read the
   "Detected contract" line — it checks the whole contract registry, so it
   will report `KERIS_CAPTION_V1` there once all 10 names are found, even
   though the panel's primary compliance check now targets
   `KERIS_CAPTION_V1_PPRO` by default. If not detected, the "Missing
   required" line (checked against whichever contract is the target) lists
   exactly which names weren't found — go back to the Essential Graphics
   panel, fix the naming/exposure, re-export, re-run. See
   `docs/PREMIERE_HOST_TEST.md` and `docs/TEMPLATE_INSPECTOR.md` for the
   full manual procedure.

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
`paramMap` for all ten fields.

## Example presets

The four example presets that used to live here
(`white-clean-subtitle.json`, `blue-keyword.json`, `yellow-impact-word.json`,
`beige-background-card.json` in `mogrt-contracts/presets/`) are now bound
to `KERIS_CAPTION_V1_PPRO` instead, since that's the contract they're
actually achievable against without After Effects — see
`mogrt-authoring/PREMIERE_ONLY_GUIDE.md` §9 for the same four looks and
why one Premiere-only master template covers all of them. If you're
building a full AE-authored `KERIS_CAPTION_V1` template, those four JSON
files are still a reasonable starting point for style values — just set
`mogrt.contractId` back to `"KERIS_CAPTION_V1"` (and `mogrt.path` to your
own exported `.mogrt`, either way).
