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

## Second real host run: the deep probe hung indefinitely

[CONFIRMED — real Premiere Pro 26.3 host] Running the Diagnostic Inspector
again (after the classification fix and value-serialization fix above) hung
on "Running diagnostic scan" and never completed — no JSON could be saved.
Root cause: the deep probe (added in commit 3371e29) awaited every
Promise-like host value it found with no timeout at all. Something in the
probed object graph — the track item, its project item, one of the three
components, or one of their 20 params — is Promise-like (has a `.then`) but
never calls either callback, so a bare `await` on it blocked forever, and
because everything in the probe runs sequentially, that one stuck `await`
stalled the entire scan.

Fixed with three independent, stacked bounds (see `src/ppro/deepProbe.js`'s
module doc-comment for the full rationale):

1. **Per-call timeout** (`src/ppro/introspect.js`'s `withTimeout()` /
   `resolveHostValueDetailed()` / `safeResolve()`, default 400ms) — no
   single host value is ever awaited past this, timeout or not; a timed-out
   field/method is recorded as `{ timedOut: true, method, stage }` and the
   scan moves on.
2. **A shared scan budget** (`createScanBudget()`, default ~12s total,
   plus a cooperative cancel token) — checked before every single field
   read, method call, param, and component, so total scan time is bounded
   regardless of how much there is to probe (a per-call timeout alone
   doesn't bound *breadth* — e.g. 20 params × up to 300 fields each could
   still add up to minutes even at 400ms/call). The moment it expires,
   remaining work is recorded as skipped/truncated rather than attempted,
   and the run finishes with `partial: true` instead of hanging.
3. **Structural caps** (max prototype depth, max own-property count, max
   method calls, max array sample size) plus WeakSet-based cycle detection
   (a self-referential array or object no longer causes infinite
   recursion in `summarizeHostValue()`) — bounds the sheer *amount* of work
   even if the first two bounds were somehow bypassed.

Also added: a **Cancel** button (cooperative — stops at the next budget
checkpoint, up to ~1 timeout-worth of delay, not instant) and explicit
`[stage] …` progress log lines (inserting clip → reading track item →
probing project item → probing component *i*/*N* → probing parameter
*j*/*M* → serializing results → cleaning up) so a long-running scan is
never silent while it works.

**Net effect: the Diagnostic Inspector is now guaranteed to finish within
its scan budget (~12s) and always produce a result — full or partial — and
always clean up the temporary clip, no matter what the probed object graph
does.** Run it again and share the (possibly partial) JSON; a `partial:
true` result still tells us a lot about what was found before time ran
out.

## Third real host run: the breakthrough — AE.ADBE Text exists, and now we know why the probe hung

[CONFIRMED — real Premiere Pro 26.3 host, "Keris Master Caption.mogrt"] The
raw probe (before the fix below) reached a **4th component that the
classification scan never got to**: `componentIndex: 3`, `matchName:
"AE.ADBE Text"`, `getParamCount(): 22`. This is the genuine, editable MOGRT
text component — the thing this whole diagnostic effort has been trying to
find since the first real host run. The raw probe only got through 12 of
its 22 params before the scan budget ran out.

**Root cause, confirmed by inspecting the raw probe's own method list**:
every `ComponentParam` exposes a method called `getValueAtTime`, and
`probeSafeMethods()`'s only "does this need arguments?" signal —
`function.length` (`argCount`) — reported **0** for it, same as any real
zero-arg getter. But `getValueAtTime` genuinely requires a `TickTime`
argument; called with none, it doesn't return quickly, it hangs until the
per-call timeout fires. With `getValueAtTime` auto-called once per param
via the generic method-probing pass, that's dozens of guaranteed 400ms
timeouts before the scan could even reach component index 3 — almost the
entire scan budget, gone on a method that should never have been called at
all. `getParam()` has the same reported-argCount-of-0 problem (calling it
with no index returns `"Invalid parameter"` rather than hanging, but it's
the same underlying host-proxy quirk: **Premiere's host-proxy functions
cannot be trusted to report their own real argument count.**

### The fix

1. **`function.length`/`argCount` is no longer treated as sufficient
   evidence a method is safe to auto-call.** `src/ppro/deepProbe.js` now
   has an explicit denylist (`NEVER_AUTO_CALL_EXACT_NAMES`:
   `getParam`, `getValueAtTime`, `findNearestKeyframe`,
   `findNextKeyframe`, `findPreviousKeyframe`, `createSetValueAction`) plus
   broader name-pattern exclusions (anything ending in `AtTime`, containing
   `Keyframe`, or starting with `create`) checked **before** argCount is
   even consulted. `getValueAtTime` is now never called anywhere in this
   codebase unless a real `TickTime` is deliberately supplied (which
   nothing here does yet).
2. **A lightweight discovery-first pass.** `discoverComponents()` walks
   the component chain reading ONLY `matchName`, `displayName`, and
   `getParamCount()` per component — no method-probing, no per-param work.
   Every other phase (the classification report, the deep raw probe, and a
   new dedicated Text extraction pass) now shares this ONE discovery
   result instead of each independently re-walking the chain, which is
   also what fixes the classification report and raw probe disagreeing on
   how many components exist — they literally could not agree before,
   since each ran its own separate scan.
3. **`AE.ADBE Text` is now its own classification tier**, `"text-editing"`
   — an exact matchName check, confirmed real, not a heuristic guess —
   distinct from both `intrinsic` and the generic `graphic-or-mogrt`
   signal-based bucket. `prioritizeTextFirst()` reorders the discovered
   component list so it's probed **before** Motion/Opacity/Crop/Graphic
   Group in both the raw probe and the dedicated pass below, so it gets
   first claim on the scan budget.
4. **A dedicated `probeTextComponentDeep()` pass**, run first (before the
   generic deep probe), that enumerates every param of the Text component
   via `component.getParam(index)` (bounded by the real `getParamCount()`,
   not a blind scan) and reads: `displayName`, the `getStartValue()`
   result's constructor name, `isTimeVarying()`/`areKeyframesSupported()`
   (best-effort, feature-detected, never fatal), and — the key fix —
   that `getStartValue()` result's **inherited** `.value`/`.position`
   accessor properties. Confirmed real-host shape: `getStartValue()`
   returns `Keyframe`/`PointKeyframe` objects whose `.value`/`.position`
   are defined on the **constructor's prototype**, not as own-enumerable
   properties on the instance — which is exactly why the generic probe
   reported `value: {}` for these: `Object.keys()`-only enumeration never
   sees an inherited accessor at all. A plain property read
   (`startValue.value`) still correctly walks the prototype chain and
   invokes the inherited getter — no special access pattern needed, just
   the same timeout-guarded read as anything else (see
   `probeObjectShape()`'s new `inheritedFields`, which fixes this same gap
   generically, not just for the dedicated Text pass).
5. **Consistency.** `diagnoseMogrt()` now does exactly one chain-fetch and
   one `discoverComponents()` call, sharing the result across the
   classification report, `rawProbe`, and the new `textComponentProbe`
   section — so `components.length` in the classification report and in
   `rawProbe` can no longer disagree, and the top-level `partial` flag is
   the OR of all three phases' own partial flags.
6. **A focused `textComponentProbe` section**, saved into the raw probe
   JSON (and also present in the main diagnostic JSON, since it's the
   actual payload this whole effort has been after):
   ```json
   {
     "componentIndex": 3,
     "matchName": "AE.ADBE Text",
     "displayName": "...",
     "paramCount": 22,
     "params": [
       { "paramIndex": 0, "displayName": "...", "startValueConstructor": "Keyframe",
         "value": { "kind": "string", "...": "..." }, "position": null, "errors": [], "timedOut": false }
     ]
   }
   ```

With `getValueAtTime` no longer wasting the budget, a targeted Text-first
pass over 22 params should comfortably finish. Run the Diagnostic Inspector
again — the next milestone is a JSON result listing all 22 `AE.ADBE Text`
parameter display names and their resolved `getStartValue().value`/
`.position`.

## Fourth real host run: a timing regression, and the fix

[CONFIRMED — real Premiere Pro 26.3 host, "Keris Master Caption.mogrt"]
With `getValueAtTime` no longer wasting the budget, the very next run
completed fast and cleanly (`partial: false`, `cleanupOk: true`) — but
reported only the 3 intrinsic components again (`Opacity`, `Motion`,
`AE.ADBE Graphic Group`), `textComponentProbe: null`. The SAME MOGRT's
earlier (slower, pre-fix) raw probe had definitely found a 4th component,
`AE.ADBE Text`, at index 3.

**Root cause: Premiere apparently materializes a MOGRT's components
asynchronously after insertion.** The old, slow probe's repeated
`getValueAtTime` timeouts (400ms × dozens of calls) accidentally gave
Premiere enough wall-clock time to finish exposing `AE.ADBE Text` by the
time the scan reached component index 3. The new discovery-first pass
(previous section) is fast specifically *because* it no longer wastes that
time — but that same speed meant it queried
`trackItem.getComponentChain()` before Premiere had finished, and got a
smaller, real-but-incomplete answer (3 components) that just happened to
look internally consistent (both the classification report and the raw
probe agreed on 3, since both now share one discovery pass — the
consistency fix worked exactly as intended, it just consistently agreed on
a *stale* snapshot).

### The fix: a stabilization phase before the deep probe

`stabilizeComponentChain()` in `src/ppro/diagnostics.js` now runs
immediately after insertion, **before** any deep probing:

- Repeatedly calls `trackItem.getComponentChain()` — a genuinely **fresh**
  chain object every single poll, never reused — and runs the same
  lightweight `discoverComponents()` pass (matchName/displayName/
  paramCount only, no per-param work) against it.
- Stops the moment `AE.ADBE Text` appears in a poll's results.
- Otherwise keeps polling (300ms before the 2nd attempt, 250ms between
  later ones) until the discovered component *signature* has been
  unchanged for 2 consecutive polls **and** at least 2s have elapsed
  (a deliberately enforced minimum — evidence shows Text can appear late,
  so an early "looks stable" read is not trusted on its own), or a hard
  6s ceiling is reached.
- Every poll is recorded in `componentDiscoveryTimeline` — exactly when
  Premiere exposed each component, e.g.:
  ```json
  [
    { "elapsedMs": 0, "attempt": 1, "componentCount": 3, "components": ["AE.ADBE Opacity", "AE.ADBE Motion", "AE.ADBE Graphic Group"] },
    { "elapsedMs": 1240, "attempt": 5, "componentCount": 4, "components": ["AE.ADBE Opacity", "AE.ADBE Motion", "AE.ADBE Graphic Group", "AE.ADBE Text"] }
  ]
  ```
- If `AE.ADBE Text` still hasn't appeared once the wait ends, the log and
  UI say exactly **"MOGRT component chain did not fully initialise before
  timeout."** — never that the template lacks a Text component (a
  previous scan already proved it has one).
- The stabilization wait uses its **own** budget, entirely separate from
  the deep-probe budget: `diagnoseMogrt()` only creates the probing
  `createScanBudget({ totalMs: scanBudgetMs, ... })` (still ~12s) *after*
  stabilization finishes, so up to ~6s of MOGRT-startup waiting never eats
  into the ~12s meant for actually reading params.
- Once stabilized, the classification report, raw probe, and dedicated
  `probeTextComponentDeep()` pass all reuse that ONE final, fresh
  discovery result (fresh `Component` references from the last poll, not
  an earlier one) — so they still can't disagree with each other, and
  `AE.ADBE Text` (once found) is still probed first.

Net effect: total worst-case wall-clock time for one diagnostic run is now
bounded by stabilization (~6s) plus a fresh probing budget (~12s) — around
18s — instead of a single shared 12s budget that a slow MOGRT startup could
silently eat into before any real probing even began.
