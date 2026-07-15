# Architecture decision: how to create editable Premiere text graphics

**Status: revised after a strict capability audit of the official UXP
26.3 API against the actual shipped type declarations.** The audit
(`docs/CAPTIONTRACK_API_AUDIT.md`) eliminated Route D as a full solution —
see "What changed in this revision" below. This document's conclusion is
now: **no route currently has a documented, confirmed write path for the
full product requirement.** The recommendation section reflects that
honestly rather than picking a "best of four broken options" without
saying so.

## Why this document exists

Two independent write paths have been tried and closed:

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

A third candidate, Premiere's native Captions track (Route D below), has
now also been audited and closed as a **full** solution — it has no
creation or content-write API in the current public UXP surface at all
(see `docs/CAPTIONTRACK_API_AUDIT.md` for the complete method-by-method
inventory).

All UXP and CEP proof-of-concept code, and the Adobe bug-report repro
(`adobe-bug-report/`), are preserved as-is — nothing described in this
document has been deleted.

## Product scope (unchanged)

- timed text chunks
- editable in Premiere afterward
- multiple fonts, weights, sizes and colours
- keyword-specific emphasis
- backgrounds, shadows and graphics
- entrance/exit animation
- automatic placement on the timeline
- no After Effects required in the normal user workflow

Nothing below changes this scope, and nothing below proposes copy/paste,
markers, burned-in rendering, or After Effects as the everyday workflow —
those are explicitly excluded, not silently substituted.

## What changed in this revision

Previously (this document's first version) Route D was described as
"potentially yes, not yet confirmed" and recommended as the first thing to
check, on the strength of a search-result summary. That was correctly
flagged as unconfirmed at the time, and the audit now closes it: a direct
read of `@adobe/premierepro@26.3.0`'s actual shipped TypeScript
declarations (the exact version matching this project's target host,
`npm pack`'d and read in full — see `docs/CAPTIONTRACK_API_AUDIT.md`)
shows:

- `CaptionTrackStatic = {}` — completely empty, no static creation method.
- `CaptionTrack`'s only two write methods are `createSetNameAction(name)`
  (rename the track) and `setMute(mute)` — neither touches caption
  content.
- `Sequence` exposes only `getCaptionTrackCount()` and
  `getCaptionTrack(trackIndex)` — enumeration, not creation.
- **No caption-item class exists anywhere in the API** — no
  `CaptionTrackItem`, no `Caption`. `getTrackItems()` returns an untyped
  `[]`. There is nothing to hold text, timing, or style even if a track
  could be created.
- **No styling class exists anywhere in the API** — a full scan for
  `Title`, `Graphic`, `Style`, `Font`, `Shadow`, `Background`, `Align`, or
  `Animat*` as type names returned zero matches, for captions or anything
  else.
- Cross-checked against the newest available prerelease
  (`26.5.0-beta.61`, ahead of 26.3.0): identical capability, confirming
  this isn't a stale snapshot about to be filled in.

This also resolves a name collision worth recording: a `createCaptionTrack(projectItem,
startAtTime, [captionFormat])` method genuinely exists, but only in the
**legacy ExtendScript** API, not UXP — a search engine can conflate the
two APIs under the same class names. This document is scoped to UXP,
where no such method exists.

Route C's write-up is also strengthened this round with a direct,
non-speculative answer from Adobe developer support (surfaced via search,
not independently fetchable this session — `developer.adobe.com` and
`*.docsforadobe.dev` are blocked by this session's outbound network
policy, confirmed via the proxy's own status endpoint): asked specifically
about `PrSDKGraphic`/`PrSDKCaption`-style headers, the reply was that
*neither header exists, across either the Premiere or After Effects C++
SDK codebase.* The SDK's plugin types are importers, exporters,
effects/transitions, and generators/synthetic importers — a
titler-equivalent plugin is described as needing to use the
dynamic-disk-media-creation variant of the *importer* API, i.e. render to
a file, not author an editable native graphic. This was previously a
structural inference from documented SDK *scope*; it is now a direct
confirmation from Adobe.

## The four routes, re-ranked

### D. Native CaptionTrack API — **closed, not viable for the full requirement**

See `docs/CAPTIONTRACK_API_AUDIT.md` for the full method inventory. Every
row of the task checklist (create a track, create an item, set text, set
start/end, set font/size/fill/background/shadow/alignment, style
individual words, convert to editable graphics, animate) is **No** — not
because of an empirical rejection like `Source Text`'s `Illegal Parameter
type`, but because **the methods do not exist in the published API at
all**. Per this round's explicit instruction, no proof of concept was
built: there is no creation/write path to demonstrate.

- **Can it create editable Premiere text graphics?** No, confirmed absent.
- **After Effects required?** N/A — route is closed.
- **Engineering complexity / Windows-macOS / deployment / long-term
  support:** N/A — nothing to build against an API that isn't there.
- **Estimated proof-of-concept effort:** N/A, per task instruction not to
  manufacture one.

This is downgraded from "recommended first check" to **closed** —
correcting this document's own prior conclusion in light of direct
evidence rather than a plausible-sounding but wrong-API search summary.

### A. Older Premiere/CEP — **kept only as a narrow, temporary compatibility experiment**

Not "does CEP work on an old version" for its own sake — CEP is
deprecated regardless of the answer (Part 1). Its only remaining value is
narrower and specific: **`ComponentParam.setValue(value, updateUI)`**,
ExtendScript's legacy two-argument write call, is the **one Source-Text
write path this project has never actually tested** — every real-host CEP
run reached a broken `evalScript()` before ever attempting it (Parts
10–17). UXP's `createSetValueAction()` and ExtendScript's `setValue()` are
not proven identical; Part 2 flags a real, if unlikely, chance the legacy
calling convention takes a different native code path.

- **Can it create editable Premiere text graphics?** Unconfirmed — this is
  exactly what route A would finally test. Not expected to succeed (Part
  2's same-native-object-model argument), but the one genuinely open
  question left in this entire investigation.
- **After Effects required?** No.
- **Engineering complexity:** Low — `cep-bridge/`'s existing code needs no
  changes; only an older Premiere install is required to re-run it.
- **Windows/macOS:** Windows only, as today (`http://`-only bridge).
- **Deployment/signing complexity:** Moderate, PoC-only (unsigned/debug
  mode) — not worth solving for real distribution given CEP's end-of-life.
- **Long-term support:** Poor, deliberately temporary — explicitly framed
  as a compatibility experiment to close an open question, not a shipping
  plan.
- **Estimated proof-of-concept effort:** Hours: install one older Premiere
  version, add one new CEP command that calls
  `component.properties[i].setValue("test", true)` against `Source Text`,
  run it. This is now the **smallest concrete next step in the whole
  investigation** (see Recommendation).

### B. UXP Hybrid Plugin — unchanged, still speculative and not recommended

No new evidence this round changes this route's assessment. Still
unconfirmed and speculative: Premiere-specific Hybrid Plugin documentation
remains thin-to-nonexistent, and Part 2's "one native object model, no
binding has a documented write path" finding gives no reason to expect a
third, native binding — undocumented at any level — behaves differently.
Complexity/platform/deployment/support assessment unchanged from this
document's prior version: very high engineering complexity, separate
native builds per platform, high signing/notarization complexity, unclear
long-term support, weeks of PoC effort with a real chance of never
reaching a working write.

### C. Premiere C++ SDK — unchanged conclusion, now on direct confirmation instead of inference

Previously "very likely not [possible], for a structural reason" — now
confirmed directly: Adobe developer support states neither
`PrSDKGraphic`- nor `PrSDKCaption`-style headers exist in the Premiere or
After Effects C++ SDK, and the SDK's plugin types (importer, exporter,
effect/transition, generator) have no authoring path for editable
Essential Graphics/title/caption content — a titler-like plugin would need
the dynamic-media-creation importer variant, which renders to a file
(burned-in output), not an editable native graphic. That specific variant
is explicitly excluded from this project's scope (task 8: no burned-in
rendering as the everyday workflow), so Route C is closed for the stated
requirement, not merely deprioritized. Complexity/platform/deployment
assessment otherwise unchanged: very high engineering complexity, separate
native builds, high signing complexity, real public documentation (better
long-term support *as an SDK*) but that doesn't help since the capability
itself isn't exposed.

## Recommendation

**No route audited so far has a documented, confirmed write path that
meets the full product requirement.** That is the honest conclusion this
round's evidence supports, and it is worth stating plainly rather than
picking a "winner" among four routes that each fail the requirement for a
different reason:

- UXP `ComponentParam.createSetValueAction()` — empirically rejected
  (`Illegal Parameter type`).
- CEP `CSInterface.evalScript()` — confirmed broken on this host, and
  deprecated regardless.
- Native `CaptionTrack` — confirmed absent creation/write/styling API.
- UXP Hybrid Plugin / Premiere C++ SDK — no documented API surface at any
  level (native headers confirmed not to exist for graphics/captions).

**The smallest next proof of concept is Route A's narrow form**: reinstall
one older Premiere Pro version, add exactly one new CEP command to the
existing, unmodified `cep-bridge/` proof of concept that calls
ExtendScript's legacy `component.properties[i].setValue("test-value",
true)` against a MOGRT's `Source Text` param, and run it. This is the
**one Source-Text write attempt this entire investigation has never
actually reached** — every previous CEP round broke at the `evalScript()`
transport layer first. It costs hours, not weeks, reuses code that
already exists, and directly answers Part 2's still-open prediction
(same native object model, two bindings, does the legacy two-argument
calling convention differ from the transaction-based one?) instead of
leaving it as a theory.

If that test also fails — which Part 2's reasoning suggests is the more
likely outcome — this project is out of currently-documented options for
in-place `Source Text` mutation, and the next decision point is a product
one, not an engineering one: whether to invest weeks in Route B or C
against undocumented internals with no confirmed API to target (not
recommended without a much stronger signal than exists today), or to
revisit the product requirement itself with stakeholders — which is
explicitly out of scope for this document to decide unilaterally (task 8:
preserve the full scope; that decision belongs to product, not to this
audit).

## What was not done this round

No new architecture was implemented and no CaptionTrack proof of concept
was built, per this round's explicit instruction not to manufacture one
where no documented creation/write path exists. The `.d.ts`-level audit
(`docs/CAPTIONTRACK_API_AUDIT.md`) was judged sufficient on its own to
reach a definitive negative conclusion for Route D, without needing a
live-host run to confirm it.
