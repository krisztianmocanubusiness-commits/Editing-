# Manual host validation: Premiere Pro smoke test

This is the exact procedure to prove — inside a real Premiere Pro install,
not by reading the code — that this extension can insert one MOGRT and set
its text, font size, fill colour, position, and duration. Run this **before**
trusting the full caption pipeline (sections 1-5 of the panel). Nothing in
`src/caption/` or `src/presets/` (the transcript/chunking/keyword logic) is
exercised by this test on purpose — that logic is pure JS, already covered
by `npm test`, and irrelevant to whether the Premiere-facing calls work.

## 1. Prerequisites

- Premiere Pro 25.1 or later, with a project open.
- The [UXP Developer Tool (UDT)](https://developer.adobe.com/uxp/uxp-developer-tools/).
- One `.mogrt` file to test against. You have two options:
  - **Fastest**: in Premiere, drag any clip to a new sequence, choose
    **Graphics → New Layer → Text**, type anything, then right-click the
    resulting graphic clip in the Essential Graphics panel and **Export as
    Motion Graphics Template…** to a local file. This gives you a real
    `.mogrt` whose default text layer is usually named `Source Text` and
    whose fill is usually exposed as `Fill Color` once you check "Expose"
    on those properties in the Essential Graphics panel before exporting.
  - **More thorough**: build a template matching
    `mogrt-authoring/param-contract.json` so all five checks below can
    actually pass. See `mogrt-authoring/README.md`.
  - Either way: **before exporting**, open the Essential Graphics panel,
    select the text/box/etc. layers, and check "Expose" next to Source
    Text, Fill Color, Position, Font Size, and (if present) a background
    shape's Opacity — un-exposed properties are invisible to scripting.

## 2. Load the plugin

1. Open UDT → **Add Plugin** → select
   `premiere-caption-graphics/manifest.json` from this repo.
2. Click **Load** next to the plugin entry (Premiere Pro must already be
   running with a project open).
3. Click **Watch** (optional, for live-reload on file changes) and **Debug**
   — Debug opens the DevTools console this test's log lines are mirrored
   to (`src/util/log.js` writes every line to both the panel and this
   console).
4. In Premiere: **Window → Extensions → Caption Graphics Studio** to open
   the panel if it isn't already docked/floating.

## 3. Preconditions in Premiere

- A sequence is open and **active** (its tab is focused).
- The sequence has **at least one video track** (any content or empty).
- Nothing else required — the smoke test does not need a transcript, a
  selected clip, or an in/out range set.

## 4. Run it

1. In the panel, find **"0. Host smoke test — run this first"** at the top.
2. Click **"Choose test .mogrt…"** and pick the file from step 1.
3. Leave the default text/size/colour/position values, or change them.
4. Click **"Run Smoke Test"**.
5. Watch the DevTools console (from step 2.3) and/or the panel's **Log**
   section at the bottom of the panel.

## 5. Expected log sequence

You should see, in order (levels in `[brackets]`, exact wording may vary
slightly but the shape is fixed):

```
[info]    ════ Caption Studio host smoke test — start ════
[success] ✓ Active project found: "<your project name>"
[success] ✓ Active sequence found: "<your sequence name>"
[success] ✓ Video tracks found: V1 (#0), V2 (#1), ...
[info]    Target track resolved to index <N> (topmost existing video track).
[warn or success]  playhead line (see note below)
[info]    MOGRT path resolved: <path>
[success] ✓ Inserted MOGRT at <t>s on track index <N>.
[success or error] duration/trim line
[info]    Reading component chain…
[info]    Component 0: "<name>"
[info]      Param 0: "<name>" — type=..., currentValue=...
[info]      Param 1: ...
[info]    Component/param scan complete: <N> exposed param(s) found.
[info]    Setting exposed parameters…
[success or error] Text: ...
[success or error] Font size: ...
[success or error] Fill colour: ...
[success or error] Position: ...
[warn/success or skipped] Background opacity: ...
[info]    Summary: {...}
[success or warn] ════ Caption Studio host smoke test — finished (N/5 param checks passed) ════
```

The **"Reading component chain…"** block is the most important diagnostic
output in this whole extension: it's a full dump of every exposed
Essential Graphics parameter Premiere's scripting API can see on your
`.mogrt`, with its real display name. **Read this list before debugging
anything else** — most failures below are just a name mismatch between
what your template exposes and the candidate names this test tries
(`Caption Text`/`Source Text`/`Text`, `Font Size`/`Size`, `Fill Color`/
`Color`, `Position`/`Position X`+`Position Y`, `Background Opacity`/
`Opacity`).

Note on the playhead line: Adobe's public sample code doesn't confirm a
playhead/CTI getter on `Sequence`, so this test tries a few plausible
method names and logs whichever worked, or falls back to 0s with a
`[warn]`. A `[warn]` here is **expected and not a failure** — it does not
affect the actual pass/fail outcome, it's just telling you where the clip
landed.

## 6. Reading the result

The panel shows a badge under the Run button:

- **PASS** (green) — text, font size, fill colour, and position all set
  successfully. This confirms the core scripting path works end to end.
- **PARTIAL** (yellow) — some of those four succeeded, others didn't. Look
  at the per-field `✓`/`✗` log lines to see exactly which, and cross-check
  against the component/param dump to see whether the field's expected
  param name just isn't on this particular `.mogrt` (fixable by renaming a
  control in AE) versus the API call itself throwing (a real code issue —
  see the "Uncertain calls" table below).
- **FAIL** (red) — something earlier than the per-field checks broke (no
  active sequence, no track, insertion itself failed). Fix that first;
  the per-field checks never ran.

Background opacity is intentionally excluded from the PASS/PARTIAL
determination — the task only requires it "if available," so a `[warn]
skipping (marked optional)` line is a normal, passing outcome when your
test template has no background box.

## 7. Triage table

| Symptom in the log | Likely cause | Where to look |
|---|---|---|
| `✗ No active project/sequence` | No sequence open/focused | Open/focus a sequence in Premiere, re-run |
| `✗ listVideoTracks() returned no tracks` | Sequence has zero video tracks | Add a video track, re-run |
| `✗ insertMogrtFromPath failed: ...` | Bad path, corrupt `.mogrt`, or wrong host version | Re-export the `.mogrt`; confirm the path string is a valid local filesystem path, not a UXP `Entry` object |
| `✗ Duration: createSetEndAction threw` | Track item type doesn't support `createSetEndAction`, or transaction rejected | `src/ppro/mogrt.js` `setTrackItemEnd` |
| `✗ Text/Font size/Fill colour: no param matched` | Template doesn't expose a param under any tried name | Rename/expose the control in AE per `mogrt-authoring/param-contract.json`, re-export |
| `✗ ...: setParamValue(...) threw` | The `createKeyframe`/`createSetValueAction` call shape is wrong for that param's actual type on your host | `src/ppro/componentParams.js` — this is the flagged "unconfirmed" call; the thrown error text tells you what Premiere actually rejected |
| `✗ Position: found "Position" but no value encoding succeeded` | Position's real value shape isn't array/`{x,y}`/`{horiz,vert}` | Add the correct encoding to `trySetPosition` in `src/ppro/smokeTest.js`, informed by the component dump's `currentValue` for that param |
| Component dump shows 0 params | `.mogrt` was exported with nothing "Exposed" in Essential Graphics | Re-export with the relevant properties checked |

## 8. What this test intentionally does not prove

- It does not validate `src/caption/chunker.js`, `keywords.js`, or the
  transcript parsers — those are pure JS, already covered by `npm test`,
  and have nothing to do with the Premiere host.
- It does not validate gradient, background box, shadow, blur, or
  entrance/exit animation params — those follow the exact same
  `setParamValue`/`ComponentParam` mechanism proven here, so once
  text/size/colour/position/duration are confirmed working, the rest of
  `src/presets/mogrtContract.js`'s fields are the same call shape against
  different param names, not new API surface.
- It does not prove multi-chunk application (`applyCaptions.js`'s loop) —
  that's the same single-chunk path repeated; once one chunk works
  reliably, apply a short (2-3 chunk) real transcript through the full
  panel next as the next validation step, not more smoke-test iteration.
