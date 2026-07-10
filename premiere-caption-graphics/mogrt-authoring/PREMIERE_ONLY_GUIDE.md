# Building a KERIS_CAPTION_V1_PPRO master `.mogrt` — Premiere Pro only, no After Effects

**Target version:** Premiere Pro 26.3. **Status:** §5's replacement contract,
`KERIS_CAPTION_V1_PPRO`, is now real, shipped code — see
`src/presets/contracts/kerisCaptionV1Ppro.js` — and is the recommended
**default** contract `src/ppro/smokeTest.js` and the Template Inspector
check against. Everything below reflects the real, implemented parameter
names; this guide is that contract's `docPath`.

## Read this first: what's actually confirmed vs. best-effort

This guide is grounded in Adobe's current documentation and community
threads about Premiere Pro's **Properties panel** and **Graphics Templates
panel** (which replaced the old Essential Graphics panel starting in
version 25.0 — Premiere Pro 26.3 uses this newer UI, not the older
screenshots you'll find in most tutorials). I do not have hands-on access
to a running Premiere Pro 26.3 install, so claims below are marked:

- **[CONFIRMED]** — stated directly in Adobe's own documentation or
  corroborated by multiple independent sources.
- **[LIKELY]** — consistent with documented behavior and Premiere's general
  design patterns, but I could not find an explicit confirmation for the
  exact 26.3 UI interaction.
- **[NOT SUPPORTED]** — explicitly confirmed as unavailable, including in
  Adobe's own community forum from users hitting this exact wall.

Wherever something is **[LIKELY]**, the authoritative check is this
extension's own **Template Inspector** (panel section "1. Template
Inspector") — inspect your exported `.mogrt` there and trust its
COMPLIANT/NOT COMPLIANT report over this document's predictions. See
§8.

## Quick answer (§3, §4, §5 up front)

**No — a Premiere-only-authored `.mogrt` cannot expose all 10
`KERIS_CAPTION_V1` fields as specified.** Two of the ten are architecturally
unavailable without After Effects:

| Field | Premiere-only? |
|---|---|
| Text | **[CONFIRMED]** yes |
| Font Size | **[CONFIRMED]** yes |
| Fill Color | **[CONFIRMED]** yes |
| Background Opacity | **[LIKELY]** yes, separate control from Background Color |
| Background Color | **[LIKELY]** yes, separate control from Background Opacity |
| Tracking | **[CONFIRMED]** yes |
| Shadow Opacity | **[LIKELY]** yes, separate control from Shadow Color |
| Position X | **[NOT SUPPORTED]** — see below |
| Position Y | **[NOT SUPPORTED]** — see below |
| Entrance Style | **[NOT SUPPORTED]** — see below |

**Position X / Position Y**: Premiere does not let you split a Position
property into independently keyframable/exposable X and Y components the
way After Effects' "Separate Dimensions" does — this is confirmed by
Adobe's own community forum, where users asking for exactly this were told
it isn't available in Premiere. Premiere-native graphics only ever expose
**one combined `Position` point control**.

**Entrance Style**: this contract field is an integer selector (0–5) that's
meant to drive *which pre-built animation rig plays*, via an expression
reading the slider and switching between keyframed looks on
position/opacity/scale. That mechanism depends on two things After Effects
has and Premiere does not: (1) arbitrary custom-named parameter controls
(AE's "Slider Control," "Checkbox Control," etc. — pseudo-effects whose
only job is to create a controllable value), and (2) an expression engine
to make one property conditionally drive another's keyframes. Premiere
supports neither for native graphics — only literal, direct keyframing per
property, no expressions. There is no way to build "pick an animation
style from a dropdown" in Premiere-only authoring.

**Practically**, this doesn't block you *if you add one more exposed
property beyond the 10*: `src/ppro/applyCaptions.js`'s
`applyChunkToTimeline()` has a graceful fallback for exactly this — if no
`Entrance Style` param is found, it synthesizes a basic opacity fade in/out
instead of failing. But I checked the actual code (`applyCaptions.js`
lines 51–68) and that fallback only activates if the template exposes a
param literally named **`Fill Opacity`** (`resolveParamName(preset,
"fillOpacity")`, which — since `KERIS_CAPTION_V1`'s `paramMap` doesn't
define `fillOpacity` — resolves to the generic default name `"Fill
Opacity"`, not `Fill Color` and not `Background Opacity`). `Fill Opacity`
is **not** one of the 10 required fields, so a template built to expose
*exactly* the 10 (or the 8 in §5's replacement) does **not** get this
fallback for free — entrance/exit is skipped entirely, not downgraded to a
fade. §1/§2/§5/§6 below add `Fill Opacity` as a 9th exposed property
specifically so this fallback actually fires.

## 1. How to create the source graphic

Build **one text layer** — you don't need a separate background shape
layer; Premiere's text tool has a built-in Background box control (see §2)
that covers `Background Opacity`/`Background Color` without a second layer.
Fewer layers means fewer places for exposed-parameter names to get
inconsistent, and keeps this a genuine single master template all four
example presets can share (§9).

1. Open or create a sequence at your target caption frame size (e.g.
   1080×1920 for vertical captions).
2. Press **T** (Type tool), click once in the Program Monitor, and type
   placeholder text — e.g. `SAMPLE CAPTION TEXT`. This creates a new
   **Graphic** clip on the topmost video track.
   [CONFIRMED — the Type tool + click-to-create-a-Graphic-clip workflow is
   Premiere's standard text-creation path in current versions.]
   - Alternative path: **Window → Properties** to open the Properties
     panel, then use its **"Create New Graphic" → "Text"** control. Same
     result, different entry point. [LIKELY — this is the documented
     replacement for the old Graphics → New Layer → Text menu item.]
3. With the new Graphic clip selected, open **Window → Properties** if it
   isn't already open. This panel is now where you set every property this
   contract needs (font, size, tracking, fill, background, shadow,
   position) — it replaced the old Essential Graphics panel's "Edit" tab.
   [CONFIRMED — Adobe's own migration documentation states editable
   graphic controls moved from Essential Graphics to the Properties panel
   starting in version 25.0.]
4. In the Properties panel's **Text** section, set:
   - Font family and style (pick a style your installed font actually has
     — e.g. "Bold" — Premiere doesn't expose a numeric weight slider the
     way `font.weight` in this extension's preset schema implies; that's a
     values-you-choose-at-authoring-time thing, not a runtime-exposed
     field, and isn't one of the 10 required fields anyway).
   - **Size** — this becomes `Font Size`.
   - **Tracking** — this becomes `Tracking`.
5. In the **Appearance** section:
   - **Fill**: enable it, set a placeholder color and **Opacity** (e.g.
     white, 100%). The color becomes `Fill Color`; the opacity value
     becomes `Fill Opacity` — not one of the 10 `KERIS_CAPTION_V1` fields,
     but expose it anyway (see the note above §1): it's what
     `applyChunkToTimeline()`'s existing entrance/exit fade fallback
     specifically looks for. [LIKELY — inferred from Background and
     Shadow both documented as having separate color/opacity controls; I
     could not independently confirm Fill follows the identical pattern.
     Verify with the Template Inspector (§8) — if Premiere's Fill really
     does bundle opacity into the color swatch's alpha with no separate
     field, you simply won't have a `Fill Opacity` to expose, and
     entrance/exit falls back to a hard cut instead of a fade. Not fatal,
     just less polished.]
   - **Background**: enable the checkbox. Set a placeholder color and
     **Opacity**, and a **Size**/corner-radius value that gives comfortable
     padding around your placeholder text. The color becomes
     `Background Color`, the opacity value becomes `Background Opacity`.
     [LIKELY — Adobe's documentation on text appearance describes
     Background as having its own checkbox, color swatch, opacity, and
     size/corner-radius controls, distinct from Fill.]
   - **Shadow**: enable the checkbox. Set color, **Opacity**, angle,
     distance, and size/blur to reasonable placeholder values. The opacity
     value becomes `Shadow Opacity`. [LIKELY — same sourcing as
     Background; Adobe's docs describe Shadow's color, opacity, angle,
     distance, and blur as distinct controls.]
6. In the **Transform** section, set **Position** to wherever you want the
   caption anchored by default (e.g. horizontally centered, positioned in
   the lower third). This single Position control is what becomes your
   `Position` parameter (see §5 — there is no split X/Y in Premiere).

Do not add a gradient fill, a blur effect, or a second "emphasis" text
layer — `KERIS_CAPTION_V1` doesn't require any of those, and adding them
only adds exposed-parameter surface area this guide's replacement contract
(§5) doesn't need.

## 2. How to expose editable properties in Premiere

With the old Essential Graphics panel's "Edit" tab gone, exposing a
property for MOGRT export now happens through the **Properties panel**
directly: current Adobe documentation describes an eye/toggle-style
"expose" affordance next to each property row when you're preparing to
export, functionally replacing the old checkbox column. [LIKELY — I
could not find an exact confirmed click sequence for the post-25.0 UI, but
every source agrees the *capability* (choosing which properties become
editable in the exported template) is still there, just relocated. This
is the single most important thing to verify hands-on before trusting any
`.mogrt` you build from this guide — see §8.]

What you're doing conceptually, regardless of exactly where the toggle
lives in 26.3's UI: for the Graphic clip (or its text layer, depending on
what level of the property tree the toggle appears at), mark these
properties as exposed:

- Source Text
- Font Size
- Fill → Color
- Fill → Opacity (see §1 — needed for the entrance/exit fade fallback, not one of the 10 required fields)
- Background → Color
- Background → Opacity
- Tracking
- Shadow → Opacity
- Position (Transform)

Leave Font Weight/Style, Stroke, Background corner radius/size, and Shadow
angle/distance/blur **un-exposed** — they're not part of the replacement
contract in §5, and every exposed property is one more thing an editor
using this extension could accidentally break if the .mogrt gets re-edited
later.

## 3. Whether Premiere can expose all 10 contract fields

**No.** See the table at the top of this document. 7 of the 10 are
achievable (2 of those 7 only [LIKELY], pending your own verification); 2
(`Position X`, `Position Y`) are confirmed unavailable and 1
(`Entrance Style`) is architecturally unavailable without After Effects'
expression engine and custom parameter controls.

## 4. Which fields cannot be exposed directly

- **`Position X`, `Position Y`** — Premiere only exposes a single combined
  `Position` point control. No "Separate Dimensions" equivalent exists for
  native Premiere graphics. **[NOT SUPPORTED — confirmed]**
- **`Entrance Style`** — requires a custom-named parameter control plus an
  expression to make it conditionally drive other properties' keyframes,
  neither of which exist in Premiere's native graphics engine.
  **[NOT SUPPORTED — architectural]**

## 5. Recommended replacement contract: `KERIS_CAPTION_V1_PPRO`

This is now real, shipped code — `src/presets/contracts/kerisCaptionV1Ppro.js`,
registered first (i.e. preferred/default) in
`src/presets/contracts/index.js` alongside `KERIS_CAPTION_V1`, which
remains fully supported for After-Effects-authored templates. Full text:

```js
export const KERIS_CAPTION_V1_PPRO = {
  id: "KERIS_CAPTION_V1_PPRO",
  version: 1,
  label: "Keris Caption v1 (Premiere-only)",
  docPath: "mogrt-authoring/PREMIERE_ONLY_GUIDE.md",
  compatibility: "premiere-only",

  requiredParams: [
    "Text",
    "Font Size",
    "Fill Color",
    "Position",
    "Background Opacity",
    "Background Color",
    "Tracking",
    "Shadow Opacity",
  ],

  // Not required — a template missing it still reports COMPLIANT — but
  // exposing it is what lets applyChunkToTimeline()'s entrance/exit fade
  // fallback actually animate something.
  recommendedOptionalParams: ["Fill Opacity"],

  paramMap: {
    captionText: "Text",
    fontSize: "Font Size",
    fillColor: "Fill Color",
    fillOpacity: "Fill Opacity",
    // Both keys resolve to the SAME name on purpose: flattenPresetForMogrt()
    // in src/presets/mogrtContract.js detects when positionX and positionY
    // resolve to one shared name and emits a single "point"-kind
    // instruction instead of two "number"-kind ones. The real apply path
    // (src/ppro/applyCaptions.js) and the smoke test
    // (src/ppro/smokeTest.js) both write it via setPointParamValue() in
    // src/ppro/componentParams.js, which tries the same three plausible
    // value encodings (array, {x,y}, {horiz,vert}) either way.
    positionX: "Position",
    positionY: "Position",
    bgBoxOpacity: "Background Opacity",
    bgBoxColor: "Background Color",
    tracking: "Tracking",
    shadowOpacity: "Shadow Opacity",
    // animationStyleIndex intentionally omitted — no Entrance Style.
    // applyChunkToTimeline()'s existing "no baked animation found" fallback
    // (a plain opacity fade on Fill Opacity) covers this gap with zero
    // extra code IF Fill Opacity is exposed (see §1).
  },
};
```

Two notes on how this is actually wired up, since "the mapping layer" is
more than just this one file:

- `recommendedOptionalParams` is documentation-only — `validateAgainstContract()`
  in `src/presets/contractValidation.js` only reads `requiredParams`. A
  template missing `Fill Opacity` still reports COMPLIANT; it just means
  the entrance/exit fade fallback has nothing to animate, so caption
  graphics hard-cut in and out instead of fading.
- The combined-`Position` handling isn't a per-contract special case
  scattered through the codebase — it's one generic rule in
  `flattenPresetForMogrt()`: if `positionX` and `positionY` resolve to the
  *same* param name (true for any contract or `paramMap` override that
  maps them that way, not just this one), it emits the combined
  instruction; otherwise it emits the split one. `KERIS_CAPTION_V1`-bound
  presets are unaffected — their `positionX`/`positionY` still resolve to
  two different names, so they keep getting two separate instructions.

## 6. Exact parameter names to use

Try to name your exposed properties **exactly** as follows when Premiere's
expose UI lets you set a custom label:

```
Text
Font Size
Fill Color
Fill Opacity      (recommended, not strictly required — see §5)
Position
Background Opacity
Background Color
Tracking
Shadow Opacity
```

**If Premiere doesn't let you rename the label** (§2 is [LIKELY], not
confirmed) and instead forces its own default — e.g. `Source Text` instead
of `Text` — that's not a dead end. This extension's `resolveParamName()`
resolves names in three tiers: an explicit `preset.mogrt.paramMap`
override always wins over a contract's default names (see
`src/presets/mogrtContract.js`). Whatever Premiere actually calls each
property, set that as the value in `paramMap` for the matching preset
field key, and everything downstream works unchanged. §8 tells you how to
find out what Premiere actually called each one.

## 7. How to export the final MOGRT

1. Right-click the Graphic clip on the timeline (or select it and use the
   Graphics Templates panel's export control, if the top-level Graphics
   menu isn't present in your layout) and choose **Export As Motion
   Graphics Template…**. [CONFIRMED as a still-working path — the
   right-click export action is documented as unaffected by the Essential
   Graphics → Properties panel migration.]
2. Choose **Local Drive** as the destination (not a Creative Cloud
   Library) and pick a clear filename, e.g. `keris-caption-v1-ppro-master.mogrt`.
3. Save it somewhere this extension's file pickers can reach — any local
   path is fine (the panel's "Choose .mogrt…" buttons use a native file
   picker, not a fixed folder).

## 8. How to verify the exposed parameter names before running the extension

Don't trust this guide's §2/§6 predictions blind — verify with the tools
already built for exactly this:

1. Open Caption Graphics Studio in Premiere, go to panel section **"1.
   Template Inspector."**
2. Click **"Choose .mogrt to inspect…"** and select the file from §7.
3. Click **"Inspect Template."** It inserts the template temporarily,
   reads every exposed parameter's *real* name via the live component
   chain, removes the temporary clip, and reports:
   - the exact discovered parameter names (in the log, one line per
     param — this is the ground truth for whatever Premiere actually
     called each property, resolving the §2/§6 uncertainty definitively
     for your build);
   - COMPLIANT/NOT COMPLIANT against `KERIS_CAPTION_V1_PPRO` — the panel's
     compliance check now targets this contract by default, since it's the
     one this guide builds toward — with a **"Premiere-only compatible"**
     label right next to the verdict;
   - a **"Detected contract"** line that checks the *whole* registry, not
     just the default target — if your template happens to also satisfy
     the fuller `KERIS_CAPTION_V1` (e.g. you exposed split `Position X`/
     `Position Y` in After Effects after all), it reports that instead,
     labeled **"After Effects / full contract"**;
   - which extra params (if any) it found beyond what's required.
4. If a discovered name doesn't match what you intended (e.g. Premiere
   exposed `Source Text` instead of `Text`), that's your signal to either
   go back and try renaming it in Premiere, or set `paramMap` as described
   in §6.
5. As a second, stronger check, run panel section **"0. Host smoke test"**
   against the same file — it also targets `KERIS_CAPTION_V1_PPRO` by
   default, and doesn't just detect names: it actually *writes* test
   values to each field and reports per-field success/failure, catching
   cases where a name matches but the value type Premiere expects turns
   out to differ from what `src/ppro/componentParams.js` sends (see that
   file's docs on unconfirmed color/string/point call shapes). Only fields
   `KERIS_CAPTION_V1_PPRO` actually requires count toward its PASS/PARTIAL
   badge, so a template built exactly to this guide's spec (no
   `Entrance Style`) can still show PASS.

Both tools already exist in the shipped extension — no code changes
needed to use them.

## 9. Can a single master MOGRT support all four presets?

**Yes.** `white-clean-subtitle`, `blue-keyword`, `yellow-impact-word`, and
`beige-background-card` (`mogrt-contracts/presets/*.json`) are now bound
to `mogrt.contractId: "KERIS_CAPTION_V1_PPRO"` and were designed without
needing gradient, blur, or a second text layer — checking each file
confirms `gradient.enabled: false` and `emphasis.enabled: false` in all
four, and only `beige-background-card.json` turns `backgroundBox.enabled`
on. That
means every visual difference between the four is expressible as **value
changes on the same eight required fields** (plus optional `Fill Opacity`)
this guide's master template exposes. Four representative columns shown
below — `Position` (offsetY ranges from -150 to -200 across the four) and
`Shadow Opacity` (25–80) also differ per preset but are omitted here for
width; `Background Color` only meaningfully differs for Beige Background
Card, since it's the only one with the background box turned on:

| Preset | Fill Color | Font Size | Tracking | Background Opacity |
|---|---|---|---|---|
| White Clean Subtitle | white | 60 | 10 | 0 (off) |
| Blue Keyword | blue | 76 | 20 | 0 (off) |
| Yellow Impact Word | yellow | 110 | 40 | 0 (off) |
| Beige Background Card | dark brown | 58 | 8 | 92 (on) |

One master `.mogrt`, one preset JSON per look, same template `path` in
all four `mogrt.path` fields. The only thing you lose across all four
compared to the original design intent is each preset's distinct
`animation.entrance.style` — checking the actual files: White Clean
Subtitle is `fade` (no loss — that's already the fallback's behavior),
Blue Keyword and Yellow Impact Word are both `pop`, and Beige Background
Card is `slide-up`. Without `Entrance Style` exposed, all four fall back
to the same plain opacity fade, so Blue Keyword and Yellow Impact Word
lose their punchier pop-in, and Beige Background Card loses its slide-up
motion. That's a real, visible downgrade worth knowing about, not a
hidden one.
