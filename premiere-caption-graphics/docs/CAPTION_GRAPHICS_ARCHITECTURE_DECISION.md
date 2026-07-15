# Architecture decision: how to create editable Premiere text graphics, now that CEP ExtendScript is confirmed unavailable

## Why this document exists

Two independent write paths have now been tried and closed:

1. **UXP** (`docs/MOGRT_DIAGNOSTIC.md`, nine real-host rounds): can
   **locate** a MOGRT's `Source Text` `ComponentParam` reliably, but every
   documented write shape for `createSetValueAction()` was rejected with
   `Illegal Parameter type`.
2. **CEP/ExtendScript** (`docs/CEP_BRIDGE_INVESTIGATION.md`, seventeen
   parts): confirmed, on the live host, that `CSInterface.evalScript()`
   itself does not work at all — even `app.name`, a built-in global with
   no dependency on this project's code, returns the literal `"EvalScript
   error."` (Part 17). Adobe's own posted timeline already flagged
   ExtendScript support as frozen and ending "through September 2026"
   (Part 1) — this failure is consistent with, and may simply be an
   instance of, that shutdown.

Both the UXP and CEP proof-of-concept code are preserved as-is (nothing
deleted); this document is the requested comparison of what to try next,
without implementing anything yet.

## Product scope (unchanged)

transcript → timed chunks → AI/manual style selection → editable text
graphics automatically created and timed in Premiere.

Nothing below changes this scope. What's actually in question is narrower:
**the mechanism Premiere accepts for programmatically creating/timing an
editable text graphic**, given that the two mechanisms tried so far
(UXP's `createSetValueAction`, ExtendScript's `evalScript`) are each
blocked for a different reason.

## The four routes

### A. Test an earlier Premiere Pro release where CEP `evalScript()` works

Reinstall an older Premiere Pro version (Creative Cloud keeps prior
releases installable) and re-point the existing, unmodified `cep-bridge/`
code at it, starting with the same `app.name` bypass test used to confirm
the current failure.

- **Can it create editable Premiere text graphics?** Unconfirmed either
  way, and even a "yes" on `evalScript()` working doesn't answer the
  original question this whole CEP side-channel exists to test: whether
  ExtendScript's `ComponentParam.setValue()` can actually write `Source
  Text`, which was never reached because `evalScript()` itself broke
  first. Part 2 of the CEP investigation predicts (from API-surface
  equivalence, not certainty) that `setValue()` likely hits the same
  native rejection UXP's `createSetValueAction()` did — a working
  `evalScript()` reopens the test, it doesn't guarantee the result.
- **After Effects required?** No.
- **Engineering complexity:** Low. Zero new code — the entire
  `cep-bridge/` proof of concept, its bypass tests, and its regression
  suite already exist and are untouched.
- **Windows/macOS:** CEP itself runs on both, but this project's bridge
  currently only works on Windows (`src/ppro/cepBridge.js`'s header
  comment: Premiere disallows plain `http://` on macOS; the bridge would
  need a self-signed HTTPS listener to run there, not yet built).
- **Deployment/signing complexity:** Moderate and already-solved for a
  PoC — CEP extensions load unsigned in debug mode (`PlayerDebugMode`
  registry/plist flag), which is exactly how this project's bridge has
  been tested so far. Real distribution to end users would need ZXP
  packaging and a signing certificate, and CEP's Adobe-side end-of-life
  makes that investment questionable.
- **Long-term support:** Poor, deliberately. This route is explicitly
  "does an old, already-deprecated mechanism still work on an old,
  unsupported host" — useful as a fast, cheap diagnostic to close out
  Part 17's open question, but not a viable long-term architecture
  regardless of its answer. CEP is a dead end on any currently-shipping or
  future Premiere version.
- **Estimated proof-of-concept effort:** Hours. Install one older Premiere
  version, run the existing `app.name` bypass test unchanged. This is the
  cheapest possible next step, but its ceiling is low: at best it confirms
  a theory about a version this project won't ship against.

### B. UXP Hybrid Plugin with native C++

Adobe's UXP Hybrid Plugin mechanism lets a UXP plugin bundle native code
(C++) that JS can call into, primarily documented today for Photoshop and
InDesign. The idea would be for native code to reach past whatever
boundary is rejecting `Source Text` writes in both bindings tried so far.

- **Can it create editable Premiere text graphics?** Unconfirmed and
  speculative in a way the other three routes aren't. Part 2's finding —
  that UXP's `premierepro` module and ExtendScript's DOM are two JS
  bindings over the **same underlying native Component/ComponentParam
  object model** — means a Hybrid Plugin's native code would still need
  to go through, or around, that same native validation layer, which
  Adobe has not published an API for at any level, including native.
  There is no evidence a native binding exists for this at all; this
  route assumes one might, without a documented API to target.
- **After Effects required?** No.
- **Engineering complexity:** Very high. Hybrid Plugin support for
  Premiere specifically is thin-to-nonexistent in Adobe's current public
  documentation (examples are Photoshop/InDesign-centric); building one
  here starts from reverse-engineering undocumented Premiere internals,
  not from a published API surface.
- **Windows/macOS:** Requires separate native C++ builds per platform,
  doubling the build/test matrix versus the pure-JS routes.
- **Deployment/signing complexity:** High. Native binaries need
  per-platform code signing (and macOS notarization), plus UXP manifest
  permissions for native-module loading.
- **Long-term support:** Unclear and high-risk. This is an early/limited
  Adobe capability with sparse Premiere-specific precedent; betting a
  shipping feature on it means betting on undocumented behavior staying
  stable across Premiere updates.
- **Estimated proof-of-concept effort:** Weeks, with a real chance the PoC
  never reaches a working Source Text write regardless of time invested,
  since success depends on undocumented internals Adobe has never
  published for any binding.

### C. Premiere C++ SDK / native plugin

Build against Adobe's official, downloadable Premiere Pro SDK (plugin
types: import/export, effects, generators) rather than either scripting
binding.

- **Can it create editable Premiere text graphics?** Very likely not, for
  a structural reason rather than a bug: Adobe's public Premiere Pro SDK
  documentation scopes plugins around media I/O and effects processing
  (PiPL-style plugins), not around authoring/mutating Essential
  Graphics/MOGRT scene data — there is no documented Source-Text-adjacent
  API here either. This route would most likely hit the same "Adobe never
  published this" wall the other three do, just from native C++ instead
  of a scripting binding. The one genuinely different option this route
  opens is **not mutating Source Text at all**: a custom generator/effect
  plugin could render the caption text itself directly into a video
  layer, sidestepping Essential Graphics entirely — but that is a
  materially different feature (a burned-in render, not an editable
  Premiere text graphic) and would need explicit product sign-off before
  being treated as satisfying the current scope.
- **After Effects required?** No (Premiere's SDK is separate from AE's),
  though the same structural limitation is expected to hold for AE's C++
  SDK too.
- **Engineering complexity:** Very high. Native plugin host architecture
  (host-side callback suites), a compiled binary registered with
  Premiere, and an SDK that is versioned per Premiere release (plugins can
  break across Premiere updates and need revalidation).
- **Windows/macOS:** Separate native builds required, as in route B.
- **Deployment/signing complexity:** High. Native binary installation,
  per-platform signing/notarization, and SDK-version compatibility
  tracking across Premiere releases.
- **Long-term support:** Better than routes A/B in one specific sense —
  Adobe does maintain real public documentation and a developer forum for
  this SDK — but that durability doesn't help if the SDK simply doesn't
  expose the capability needed, which is the likely outcome here.
- **Estimated proof-of-concept effort:** Weeks to over a month for a
  minimal "hello world" plugin using Adobe's sample SDK code — and that
  PoC would still not answer whether Source Text mutation is possible,
  because the documented SDK scope suggests it structurally isn't.

### D. An official, current Premiere caption/graphics API that avoids Source Text mutation entirely

Premiere Pro's native **Captions** feature (its own track type, Essential
Graphics-adjacent but architecturally separate from generic MOGRT title
graphics — SRT/VTT import, the Text-Based Editing panel, Caption Styles
for font/color/position/background, and "burn in" to Open Captions) has
never been investigated in either the UXP or CEP rounds of this project.
If Premiere's public UXP scripting API (the `premierepro` module) exposes
any way to create/populate a Captions track programmatically, that would
be a **completely different data path from `ComponentParam`/`Source
Text`** — the exact bottleneck both prior routes hit — while staying
inside the already-built, already-working UXP extension.

- **Can it create editable Premiere text graphics?** Potentially yes, and
  for a fundamentally different reason than routes A–C: this wouldn't be
  fighting the same `Source Text` write rejection at all, since native
  Captions are not `ComponentParam`-based MOGRT text. This is **not yet
  confirmed** — this project has never checked whether the current
  `premierepro` UXP API publishes a caption-track creation/import method,
  and that needs a fresh read of Adobe's current UXP API reference (it
  changes per release) before any effort is committed. Native Captions
  also come with real styling controls (Caption Styles: font, size,
  color, position, background), which plausibly satisfies "AI/manual
  style selection," though it is more constrained than a fully custom
  MOGRT template with arbitrary animation.
- **After Effects required?** No.
- **Engineering complexity:** Low to moderate, *if* the API exists —
  reuses the entire existing UXP extension (transcript ingestion,
  chunking, keyword/emphasis logic, the approval workflow) unchanged; only
  the final "create the graphic" step would be re-targeted from MOGRT
  `Source Text` to a Captions-track call.
- **Windows/macOS:** Same as the rest of the UXP extension today — both,
  no separate native builds, no platform-specific HTTP/HTTPS bridge
  concerns (this route needs no CEP bridge at all).
- **Deployment/signing complexity:** Lowest of the four — identical to
  this project's existing UXP distribution model (`manifest.json`,
  `dist/main.js`), already solved.
- **Long-term support:** Best of the four by a wide margin. Captions are a
  growing first-party Premiere feature (unlike CEP, which Adobe has an
  active, dated plan to remove), and UXP is Adobe's stated forward
  direction for Premiere scripting — the opposite trajectory from CEP.
- **Estimated proof-of-concept effort:** Small if the API exists (hours to
  a day, reusing existing insertion/timing code against a new target
  call) — but effort estimate is contingent on a first step this project
  hasn't done yet: checking the current official UXP API reference for a
  documented Captions-track method. That check itself is minutes, not
  days.

## Recommendation

**Route D first: check whether the official, current `premierepro` UXP
API exposes a Captions-track creation/import method, before spending any
engineering effort on A, B, or C.** This is the only route that avoids the
exact bottleneck both prior investigations independently hit
(`ComponentParam`/`Source Text` write rejection, in two unrelated
bindings over the same native object model — Part 2's finding), stays
entirely inside the UXP extension this project already has working and
already knows how to ship, and is aligned with Adobe's actual direction
(UXP growing, CEP being actively wound down on a dated timeline this
investigation has now run into firsthand). The check itself costs minutes
against Adobe's current documentation; committing further engineering
should wait on that answer.

**Route A is worth a few hours only as a closing diagnostic**, not as a
shipping architecture — it would answer whether Part 17's `evalScript()`
failure is host-specific or a symptom of Adobe's broader ExtendScript
wind-down, satisfying curiosity and possibly informing an Adobe support
ticket, but a "yes" doesn't produce anything this project could ship: CEP
is deprecated regardless of which specific host version still runs it.

**Routes B and C should not be pursued without a much stronger signal**
than currently exists. Both require weeks of native-code investment
against undocumented Premiere internals, with a real chance the effort
concludes in the same wall UXP and CEP already hit — Part 2's core
finding (one native object model, multiple JS bindings, no exposed
Source-Text-write path in either public API) gives no reason to expect a
third binding, published or not, behaves differently. If Route D turns
out to be a dead end too, the next-cheapest remaining option is
re-examining Route C's generator/effect-plugin variant (rendering text
directly rather than mutating Source Text) — but that changes the
feature's nature and needs explicit product sign-off first, not another
open-ended engineering investigation.

## What was not done this round

No new architecture was implemented — this document is a comparison and
recommendation only, per this round's explicit instruction. The next step,
if this recommendation is accepted, is a scoped, cheap investigation of
Route D's premise (does the current UXP API publish a Captions-track
method) — not a build.
