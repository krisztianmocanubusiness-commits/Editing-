# Manual host validation: Premiere Pro smoke test

This is the exact procedure to prove — inside a real Premiere Pro install,
not by reading the code — that this extension can insert one MOGRT and set
its text, font size, fill colour, position, background, tracking, shadow,
entrance style, and duration, and that the template is compliant with the
**`KERIS_CAPTION_V1`** contract (see
[`/mogrt-contracts/KERIS_CAPTION_V1.md`](../mogrt-contracts/KERIS_CAPTION_V1.md)
for the full 10-param spec). Run this **before** trusting the full caption
pipeline (sections 1-5 of the panel). Nothing in `src/caption/` or
`src/presets/` (the transcript/chunking/keyword logic) is exercised by this
test on purpose — that logic is pure JS, already covered by `npm test`,
and irrelevant to whether the Premiere-facing calls work.

## 1. Prerequisites

- Premiere Pro 25.1 or later, with a project open.
- The [UXP Developer Tool (UDT)](https://developer.adobe.com/uxp/uxp-developer-tools/).
- One `.mogrt` file to test against. You have two options:
  - **Fastest, but likely NOT COMPLIANT**: in Premiere, drag any clip to a
    new sequence, choose **Graphics → New Layer → Text**, type anything,
    then right-click the resulting graphic clip in the Essential Graphics
    panel and **Export as Motion Graphics Template…** to a local file.
    This gives you a real `.mogrt` to test the plumbing with, but it will
    only have a couple of the 10 `KERIS_CAPTION_V1` params (typically
    just text + fill colour) — enough to prove the pipeline works, not
    enough to pass the contract-compliance check.
  - **Contract-compliant**: build a template exposing exactly the 10
    params in `mogrt-contracts/KERIS_CAPTION_V1.md`'s table (`Text`,
    `Font Size`, `Fill Color`, `Position X`, `Position Y`,
    `Background Opacity`, `Background Color`, `Tracking`,
    `Shadow Opacity`, `Entrance Style`) so every check below — including
    the compliance line — passes.
  - Either way: **before exporting**, open the Essential Graphics panel,
    select every layer, and check "Expose" next to whichever of the 10
    params above that layer owns — un-exposed properties are invisible to
    scripting.

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
[info]    ════ Caption Studio host smoke test — start (contract: KERIS_CAPTION_V1) ════
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
[success or error] KERIS_CAPTION_V1: COMPLIANT — all 10 required params found.
                    -- or --
[error]   KERIS_CAPTION_V1: NOT COMPLIANT — missing N required param(s): <exact names>. Found: <exact names>.
[info]    Setting exposed parameters…
[success or error] Text: ...
[success or error] Font size: ...
[success or error] Fill colour: ...
[success or error] Position X: ...
[success or error] Position Y: ...
[success or error] Tracking: ...
[success or error] Entrance style: ...
[warn/success or skipped] Background opacity: ...
[warn/success or skipped] Background colour: ...
[warn/success or skipped] Shadow opacity: ...
[info]    Summary: {...}
[success or warn] ════ Caption Studio host smoke test — finished (N/6 core param checks passed, contract COMPLIANT|NOT COMPLIANT) ════
```

The **"Reading component chain…"** block is the most important diagnostic
output in this whole extension: it's a full dump of every exposed
Essential Graphics parameter Premiere's scripting API can see on your
`.mogrt`, with its real display name. **Read this list, then the
`KERIS_CAPTION_V1: ...` compliance line right after it, before debugging
anything else** — the compliance line does the name-matching for you and
lists exactly which of the 10 required names (`Text`, `Font Size`,
`Fill Color`, `Position X`, `Position Y`, `Background Opacity`,
`Background Color`, `Tracking`, `Shadow Opacity`, `Entrance Style`) are
missing, with no aliasing or guessing involved.

The per-field `Text:`/`Font size:`/etc. lines further down are a
*separate*, best-effort layer: they also try a couple of legacy aliases
(e.g. `Source Text` for `Text`), so they can report a `✓` even against a
non-compliant template — that's intentional (it's what makes the test
still useful against an arbitrary template), but it means "all per-field
writes succeeded" is not the same claim as "this template is
KERIS_CAPTION_V1-compliant." Trust the compliance line for the latter.

Note on the playhead line: Adobe's public sample code doesn't confirm a
playhead/CTI getter on `Sequence`, so this test tries a few plausible
method names and logs whichever worked, or falls back to 0s with a
`[warn]`. A `[warn]` here is **expected and not a failure** — it does not
affect the actual pass/fail outcome, it's just telling you where the clip
landed.

## 6. Reading the result

The panel shows two badges under the Run button:

- **Result badge** — PASS (green) means all 6 core params (text, font
  size, fill colour, position, tracking, entrance style) were set
  successfully via the best-effort writer; PARTIAL (yellow) means some
  succeeded and some didn't (see the per-field log lines for which); FAIL
  (red) means something earlier broke (no sequence, no track, insertion
  itself failed) and the per-field checks never ran.
- **Compliance badge** — the `KERIS_CAPTION_V1: COMPLIANT` /
  `NOT COMPLIANT — missing ...` line from step 5, repeated as a status
  line so it doesn't get lost in the log. This is the authoritative
  "is my template actually contract-compliant" answer; the result badge
  above it is not.

Background opacity/colour and shadow opacity are excluded from the result
badge's PASS/PARTIAL determination (a `[warn] ... skipping` line for any
of them is a normal, non-failing outcome if your test template doesn't
expose them) — but they **do** count toward the separate compliance badge,
since `KERIS_CAPTION_V1` requires all three.

## 7. Triage table

| Symptom in the log | Likely cause | Where to look |
|---|---|---|
| `✗ No active project/sequence` | No sequence open/focused | Open/focus a sequence in Premiere, re-run |
| `✗ listVideoTracks() returned no tracks` | Sequence has zero video tracks | Add a video track, re-run |
| `✗ insertMogrtFromPath failed: ...` | Bad path, corrupt `.mogrt`, or wrong host version | Re-export the `.mogrt`; confirm the path string is a valid local filesystem path, not a UXP `Entry` object |
| `✗ Duration: createSetEndAction threw` | Track item type doesn't support `createSetEndAction`, or transaction rejected | `src/ppro/mogrt.js` `setTrackItemEnd` |
| `NOT COMPLIANT — missing ...` | Template is missing (or misnamed) one or more of the 10 required controls | `mogrt-contracts/KERIS_CAPTION_V1.md` §"Building a compliant template" — rename/expose the listed control(s) in AE, re-export |
| `✗ Text/Font size/Fill colour/...: no param matched` | Template doesn't expose a param under any tried name (contract name or legacy alias) | Same as above — this is the best-effort layer failing too, a stronger signal than compliance alone |
| `✗ ...: setParamValue(...) threw` | The `createKeyframe`/`createSetValueAction` call shape is wrong for that param's actual type on your host | `src/ppro/componentParams.js` — this is the flagged "unconfirmed" call; the thrown error text tells you what Premiere actually rejected |
| `✗ Position: found "Position" but no value encoding succeeded` | Fallback single-Point control's value shape isn't array/`{x,y}`/`{horiz,vert}` — only relevant if your template lacks split `Position X`/`Position Y` | Add the correct encoding to `trySetPosition` in `src/ppro/smokeTest.js`, informed by the component dump's `currentValue` for that param |
| Component dump shows 0 params | `.mogrt` was exported with nothing "Exposed" in Essential Graphics | Re-export with the relevant properties checked |

## 8. What this test intentionally does not prove

- It does not validate `src/caption/chunker.js`, `keywords.js`, or the
  transcript parsers — those are pure JS, already covered by `npm test`,
  and have nothing to do with the Premiere host.
- It does not validate gradient, blur, exit animation, background corner
  radius/padding, shadow angle/distance/softness, or per-word emphasis —
  none of those are required by `KERIS_CAPTION_V1` (see that doc's "What's
  deliberately not required by V1"). They follow the exact same
  `setParamValue`/`ComponentParam` mechanism already proven by the 10
  fields this test does check, so they're the same call shape against
  different param names, not new API surface — but they're still untested
  by this specific smoke test.
- It does not prove multi-chunk application (`applyCaptions.js`'s loop) —
  that's the same single-chunk path repeated; once one chunk works
  reliably and is contract-compliant, apply a short (2-3 chunk) real
  transcript through the full panel next as the next validation step, not
  more smoke-test iteration.
