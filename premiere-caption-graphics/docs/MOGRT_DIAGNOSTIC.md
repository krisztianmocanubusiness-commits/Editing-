# Diagnostic Inspector: what Premiere's UXP API actually shows us

This document exists because the Template Inspector's contract-compliance
check (`KERIS_CAPTION_V1_PPRO`) reported a real Premiere-exported "Hello
World" MOGRT as exposing only **Opacity, Blend Mode, Scale, Scale Width,
Rotation, Anchor Point, Crop controls, Anti-flicker Filter** — none of the
contract's required names, and none of them look like editable text/style
controls at all. Before building any automatic param-name mapping on top of
that discovery mechanism, we needed to answer a more basic question: **is
`trackItem.getComponentChain()` even the right place to look for a MOGRT's
own editable controls, or is it only showing the intrinsic Motion/Opacity/
Crop/Time Remapping components every track item has regardless of content?**

## What the code was actually doing

[CONFIRMED, by reading the code] `src/ppro/templateInspector.js` (via
`src/ppro/introspect.js`'s `dumpComponentChain`) and `src/ppro/mogrt.js`'s
`findExposedParam`/`findExposedParams` (used by the smoke test's apply path)
call exactly one enumeration API:

```js
const chain = await trackItem.getComponentChain();
const component = chain.getComponentAtIndex(ci);   // ci = 0..N
const param = component.getParam(pi);               // pi = 0..N
```

There is no other read path anywhere in this codebase. **Yes — the
inspector was, and still is by default, only reading whatever
`getComponentChain()` returns**, and every name it found on the reported
Hello World template (Opacity, Blend Mode, Scale, Scale Width, Rotation,
Anchor Point, Crop, Anti-flicker Filter) is a standard Premiere clip
component present on essentially every video track item — **Motion**
(Position/Scale/Scale Width/Rotation/Anchor Point/Anti-flicker Filter) and
**Opacity** (Opacity/Blend Mode) are the two most common ones, plus **Crop**
if a crop effect is present. None of these are MOGRT-specific.

## Is that the *only* enumeration API, or is there a separate MOGRT/graphics API?

[NOT CONFIRMED — researched, not settled] `developer.adobe.com` (the
official Premiere UXP reference host) and `github.com` (including
`AdobeDocs/uxp-premiere-pro`, where the reference's `types.d.ts` is
generated from a private `uxp-documentation` package dependency, not
committed as source) are both blocked by this environment's egress policy,
so the official reference pages and generated type definitions could not be
fetched directly in this session. What was reachable:

- Adobe's own forum (`forums.creativeclouddeveloper.com`) is also blocked
  directly, but web search indexed enough of it to establish, from two
  separate 2026 threads ("Setting MOGRT text parameters in Premiere UXP?"
  and "MOGRT Parameters in UXP availabilty"):
  - A `Component` object is described by Adobe/forum participants as
    "represent[ing] the parameters of the .mogrt which the creator has
    exposed" — i.e. `getComponentChain()` **is** described as the intended
    route to a MOGRT's exposed params, not just intrinsic clip properties.
  - Developers report being able to **locate** the `ComponentParam` for a
    MOGRT's `Source Text` parameter by its `matchName`, given as
    `"AE.ADBE Text"` — implying MOGRT-authored (specifically
    After-Effects-authored) text components/params *do* show up in this
    same chain, distinguishable from intrinsic components by `matchName`
    (an "AE."-prefixed match name), not by `displayName` alone.
  - Multiple developers report being **unable to reliably read or write the
    *value*** of an exposed MOGRT `ComponentParam` even once located, and
    an Adobe team member is reported as saying UXP won't get expanded MOGRT
    scripting support until UXP reaches closer parity with the older
    CEP+ExtendScript API — i.e. **this is described as a known, currently
    open platform limitation, not a bug in this project's code.**
  - No source found (official or forum) describes a *separate* API surface
    for MOGRT/graphics properties outside the `Component`/`ComponentParam`
    chain. Nothing suggests `getComponentChain()` is the wrong place to
    look.
- No official Adobe source was reachable to confirm whether `matchName`
  exists as a real property/method on `Component`/`ComponentParam` in this
  project's installed `@adobe/premierepro` version, what shape it returns,
  or whether **native Premiere Graphics** (Premiere's own Properties-panel
  authored templates, not After-Effects-authored ones) produce any
  `"AE."`-prefixed or otherwise MOGRT-identifiable `matchName` at all. The
  forum evidence above is specifically about *After-Effects-authored*
  MOGRTs (`"AE.ADBE Text"` is an After Effects text-layer match name). A
  Premiere-only "Hello World" graphic never touches After Effects, so it's
  plausible its exposed controls (if any) carry a completely different
  match-name scheme, or none at all — **this is exactly what the
  Diagnostic Inspector below is for.**

## What changed in the code this pass

**No automatic param-name mapping was built.** Per the task, that's
deliberately deferred until a real host run of the tool below settles which
discovered params (if any) are genuinely MOGRT-editable controls versus
intrinsic clip properties. What *was* added:

### Diagnostic Inspector (`src/ppro/diagnostics.js`)

A new, separate read path — **"2. Diagnostic Inspector"** in the Template
Inspector panel section — that:

1. Inserts the chosen `.mogrt` the same way the regular inspector does
   (`insertMogrtAt`/`removeTrackItem` in `src/ppro/mogrt.js` — unchanged,
   shared code).
2. Walks `getComponentChain()` with **no name assumptions** and much more
   detail than the existing dump: for every component, its `displayName`
   *and* a best-effort `matchName` (tried via both a `.matchName` property
   read and a `.getMatchName()` method call, whichever responds — see
   `readMatchName()`); for every param, the same plus `type`, the
   `typeof` of its current value, the current value itself
   (`getStartValue()`, the one confirmed-working value read already used
   elsewhere in this codebase), and whether its name contains a
   text-related signal.
3. Classifies each component as one of:
   - **`intrinsic`** — display name/matchName is an exact,
     case-insensitive match against a small known set: the plain names
     (`Motion`, `Opacity`, `Time Remapping`, `Crop`, `Channel Volume`,
     `Volume`) **and** their `AE.ADBE`-prefixed matchName forms
     (`AE.ADBE Opacity`, `AE.ADBE Motion`, `AE.ADBE Transform`,
     `AE.ADBE Time Remapping`, `AE.ADBE Crop`, `AE.ADBE Channel Volume`,
     `AE.ADBE Graphic Group`) — see "First real host run" below for why
     both forms are needed.
   - **`graphic-or-mogrt`** — name or matchName contains a *specific*
     signal (`graphic`, `mogrt`, `essential graphics`, `video/graphic`,
     `text`) — deliberately NOT a bare `ae.adbe` (see below).
   - **`effect-or-unknown`** — neither of the above. This is the
     "needs a human to look at it" bucket, deliberately not auto-resolved
     — it could be a user-applied effect, or it could be an
     unrecognized-by-this-heuristic graphic/MOGRT wrapper.
4. Logs every line to both the panel's Log section and the DevTools
   console (same `src/util/log.js` mechanism the rest of the panel uses),
   and returns the full structured report so **"Save diagnostic JSON…"**
   can write it to a file for sharing/inspection outside the panel.
5. Tolerates up to 3 consecutive empty/failed component indices before
   stopping the scan (the regular inspector's scan stops at the *first*
   miss) — specifically to rule out the possibility that a real
   graphic/MOGRT component sits at a later index than an intrinsic
   component chain's usual 2-3 entries, separated by an index the host
   doesn't populate.

This makes no claim about what the *next* diagnostic run will find — that's
the point of running it against a real host.

## First real host run: classification was wrong, and values still weren't readable

[CONFIRMED — real Premiere Pro 26.3 host, a native (no After Effects)
"Keris Master Caption.mogrt"] The Diagnostic Inspector ran successfully
(insert → scan → cleanup all completed, `cleanupOk: true`) and settled part
of the open question above, but also exposed two problems in the tool
itself:

1. **The chain has exactly 3 components on this MOGRT**: `AE.ADBE Opacity`,
   `AE.ADBE Motion`, `AE.ADBE Graphic Group` — i.e. **Premiere Graphics
   clips DO carry `AE.ADBE`-prefixed matchNames even when authored without
   After Effects.** This settles the previously-open question of whether
   that prefix is AE-authoring-specific — it isn't; it's how Premiere
   represents every graphic clip's standard components internally,
   regardless of authoring app. The first version of `classifyComponent()`
   used a bare `"ae.adbe"` substring as its "this is custom MOGRT content"
   signal, so it misclassified **all three of these standard components**
   as `graphic-or-mogrt` — i.e. reported the scan as having found real
   editable controls when it had only found the same three intrinsic
   pieces every graphic clip has. Fixed: `"ae.adbe"` was removed as a
   signal entirely; the three exact AE.ADBE-prefixed names above (plus the
   plain-name forms of the other known intrinsics) are now recognized as
   `intrinsic` directly. `AE.ADBE Graphic Group` specifically is the
   wrapper/container for whatever custom content the graphic has — still
   intrinsic to every graphic clip, not itself a discovered control.
2. **All 20 params across those 3 components reported `type: "unknown"`
   and `value: {}`.** The `{}` was `describeValue()`'s `JSON.stringify()`
   seeing nothing — UXP's native-bridge param/value objects apparently
   expose their real data through non-enumerable getters/methods, which
   `JSON.stringify` (only enumerable own properties) can't see at all. This
   isn't a crash, just an unhelpful, misleadingly-empty-looking result.
   Fixed: `describeValue()` was replaced with `summarizeHostValue()` (see
   `src/ppro/deepProbe.js`), which reads `Object.getOwnPropertyNames()` (not
   `Object.keys()`/`JSON.stringify`) and reports actual readable primitive
   fields plus a best-effort shape guess (point/color/text-document/
   collection/other), instead of an empty-looking `{}`.

Whether `AE.ADBE Graphic Group`'s 20 params are themselves the route to the
MOGRT's real editable controls (e.g. as nested property groups, each
needing its OWN component-chain-style walk) or whether they're something
else entirely is **still not settled** — this is exactly why the deeper raw
probe below was added, rather than guessing further from outside a real
host.

## Deeper raw probe (`deepProbeMogrt()` / "Save raw probe JSON…")

Separate from the classification-focused scan above (and run in the same
insert/cleanup cycle, so there's still only one temporary clip), this walks
the **track item, its associated project item (tried via a `.projectItem`
property read, then a `.getProjectItem()` method call — neither name is
Adobe-confirmed), every component, every param, and the resolved objects
from both `param.getStartValue()` and `param.getValue()`** (the latter
feature-detected — `getValue` isn't used anywhere else in this codebase and
its existence on `ComponentParam` is unconfirmed). For each of those
objects it safely records, via `src/ppro/deepProbe.js`:

- `Object.keys()` and `Object.getOwnPropertyNames()` (own, not inherited)
- the prototype chain's property/method names (bounded to 6 levels deep)
- the constructor name
- for every own key: whether its raw value was Promise-like, and a
  best-effort summary of its resolved value (never the raw value itself —
  everything here is JSON-safe)
- for every zero-argument, getter-shaped method name (matches
  `/^(get|is|has)/`, and does **not** contain a state-mutating-sounding verb
  like `set`/`remove`/`delete`/`create`/`execute`/etc. — see
  `DANGEROUS_NAME_FRAGMENTS` in `deepProbe.js`) — actually **calls** it and
  records the result. Every other method name is still listed, just not
  invoked, so this can never trigger a side-effecting host call.

This is deliberately much more verbose than the classification report, so
it's saved to its own file (`mogrt-raw-probe.json`, via "Save raw probe
JSON…") rather than folded into `mogrt-diagnostic.json`.

## Next: run it again

Run **"Run Diagnostic Inspector"** again against the same MOGRT and save
both JSON files. What to look for in the raw probe:

- Under each of the three components' `params[].probe`/`startValueProbe`/
  `getValueProbe`, any readable field name that looks like `text`, `size`,
  `color`/`colour`, `fill`, `stroke`, `position`, or similar — that's the
  strongest signal of where the real editable controls live, even if
  `classifyComponent()` still calls the containing component `intrinsic`.
- Whether `getValue()` exists on any param at all, and if so, whether its
  resolved shape differs from `getStartValue()`'s.
- Whether an associated project item was found at all (`projectItemProbe.
  shape.exists`), and if so, whether ITS method list contains anything
  graphics/MOGRT/Essential-Graphics-sounding that the track item's own
  method list doesn't.

Whatever it finds, share both JSON files — that's the ground truth the
adaptive auto-mapping design (contracts as a fast path + a proposed,
human-reviewed mapping for anything else) will be built against next. The
milestone before that design work resumes is still open: proving at least
one genuinely custom MOGRT control (ideally the caption text) can be found
and read.
