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
   - **`intrinsic`** — display name is an exact, case-insensitive match
     against a small known set (`Motion`, `Opacity`, `Time Remapping`,
     `Crop`, `Channel Volume`, `Volume`) built from what's actually been
     observed on ordinary clips, not an official Adobe list (none was
     found).
   - **`graphic-or-mogrt`** — name or matchName contains a loose signal
     (`graphic`, `mogrt`, `essential graphics`, `ae.adbe`,
     `video/graphic`).
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

### What to do with the output

Run **"Run Diagnostic Inspector"** against:

1. The same Hello World MOGRT as before, **after** actually checking
   "Expose"/enabling scripting access on some property in Premiere's
   Properties panel or Graphics Templates panel for at least one control
   (text, a color, anything) — if the earlier NOT COMPLIANT run happened
   before any property was exposed at all, finding nothing beyond
   intrinsic components would be the expected, unremarkable result, not
   evidence of a platform limitation.
2. Ideally, one After-Effects-authored `.mogrt` with a known exposed
   `Source Text` control, for comparison — if that one *does* show a
   `graphic-or-mogrt`-classified component with an `"AE.ADBE Text"`-ish
   matchName and the Hello World one still doesn't show anything beyond
   intrinsic components even after exposing a property, that's a strong
   signal native Premiere Graphics don't surface exposed controls the same
   way AE-authored MOGRTs do (or at all, via this API).

Whatever it finds, paste/share the JSON — that's the ground truth the
adaptive auto-mapping design (contracts as a fast path + a proposed,
human-reviewed mapping for anything else) will be built against next.
