# CEP/ExtendScript bridge: investigation, architecture, and proof of concept

## Why this exists

Nine rounds of UXP investigation (see `docs/MOGRT_DIAGNOSTIC.md`) reached a
conclusive result: UXP's `premierepro` module can **locate** `AE.ADBE Text`'s
`Source Text` `ComponentParam` reliably, but cannot **write** to it —
`createSetValueAction("__KERIS_WRITE_TEST__", true)` throws `Illegal Parameter
type`, and the three value shapes actually documented for that call (a raw
string, the `Keyframe.value` wrapper shape, and a mutated existing `Keyframe`)
were all probed and — per the real-host run that prompted this document — none
worked. Rather than continue probing UXP, this task asks for a hybrid
architecture: keep the whole existing UXP panel (transcript ingestion,
chunking, keyword/emphasis logic, presets, approval workflow — none of that
changes), and add a **CEP/ExtendScript side-channel** used for exactly one
job: writing the text graphic to the timeline, if ExtendScript can do
something UXP can't.

This document has two purposes: report the research findings plainly (task 1-3
below), and explain the UXP↔CEP bridge design **before** the implementation
that follows it (task 7's explicit requirement).

## Part 1: does CEP/ExtendScript still work in Premiere Pro 26.3?

Yes, but it is in its final stretch. Per Adobe's own current guidance:

- CEP extensions "continue to be supported; the plan is to support both CEP
  and UXP for a calendar year [from Premiere Pro 25.6], after which we will
  remove support for CEP extensibility."
- "ExtendScript-based integrations are still supported, and the plan is for
  them to remain so, through September 2026."
- "We've stopped additional work on the ExtendScript API... no further
  changes or improvements to Premiere Pro's ExtendScript API are planned or
  scheduled."

Premiere Pro 26.3 (this project's target host) sits inside that window: CEP
still loads and ExtendScript still executes, but Adobe has explicitly frozen
the API and given a concrete end-of-support date under a year away. Anything
built here should be understood as a bridge with a known, near-term
expiration — not a long-term architecture. (Source:
[Hyper Brew — "UXP Plugins in Premiere 2026: The CEP Migration Clock Is
Ticking"](https://hyperbrew.co/blog/uxp-plugins-in-premiere-2026/), which
summarizes Adobe's own posted deprecation timeline.)

## Part 2: the decisive finding — ExtendScript's ComponentParam is the *same* object, not a different capability

This is the single most important research result, and it directly predicts
whether the CEP path can succeed where UXP failed.

Adobe's official, current ExtendScript reference for Premiere Pro
(`docsforadobe/premiere-scripting-guide`, published at
[ppro-scripting.docsforadobe.dev](https://ppro-scripting.docsforadobe.dev/))
documents a `ComponentParam` object reached via
`trackItem.components[i].properties[j]` with exactly the same method surface
as UXP's `ComponentParam`:

- `ComponentParam.displayName`
- `ComponentParam.getValue()`
- `ComponentParam.setValue(value, updateUI)` — documented description:
  *"Sets the value of the component parameter stream. **Note: This can only
  work on parameters which are not time-variant.**"* (Source Text reports
  `isTimeVarying: false`, so this is squarely the intended use case — a
  genuinely promising sign, distinct from UXP's newer, transaction-based
  `createSetValueAction`.)
- `ComponentParam.isTimeVarying()`
- `ComponentParam.areKeyframesSupported()`
- `ComponentParam.addKey(time)` / `getKeys()`

This is not a coincidence. ExtendScript's Premiere DOM and UXP's `premierepro`
module are two different JavaScript bindings over the **same underlying
native Component/ComponentParam engine object model** — they are not
independent, competing capabilities. The `Illegal Parameter type` rejection
UXP hit almost certainly happens in native code that validates the value
against the param's real internal type, *before* either binding's JS layer
gets involved. If that validation rejects a plain string for this specific
param's internal type, there is a real chance ExtendScript's `setValue()`
hits the identical rejection, for the identical reason, in the identical
native code — not because ExtendScript is deficient, but because it is *not
a different implementation*.

This is a **prediction grounded in API-surface equivalence, not a certainty**.
`setValue()`'s legacy, simpler two-argument calling convention conceivably
takes a code path UXP's newer transaction-action API doesn't — that
possibility is real enough to be worth the empirical test the proof of
concept below performs. But it should not be assumed to work; the honest
starting expectation, based on the evidence gathered, is that it probably
won't, for the same underlying reason UXP failed.

A second, weaker but corroborating signal: both the `Sequence`-level and
`TrackItem`-level MOGRT-import methods in the official ExtendScript docs are
described as importing *"an After Effects Motion Graphics Template"* /
*"a MOGRT... created in After Effects"* — the same framing, in two separate
doc pages. That doesn't prove a Premiere-authored `.mogrt` can't be imported
via ExtendScript, but it's a second data point suggesting the whole
`.mogrt`/Essential-Graphics-text write path may have been built and tested
primarily around AE-authored templates, on both scripting surfaces.

There is no dedicated text/rich-text wrapper class documented for
`ComponentParam` anywhere in either the UXP or the ExtendScript public
references — this was already established for UXP in
`docs/MOGRT_DIAGNOSTIC.md`'s ninth entry, and nothing in the ExtendScript
docs contradicts or extends that.

## Part 3: exact ExtendScript APIs identified (grounded in the official docs above)

| Need | API | Notes |
| --- | --- | --- |
| Active sequence | `app.project.activeSequence` | |
| Video tracks | `sequence.videoTracks[i]`, `.numTracks` | |
| Insert an existing (already-imported) graphic instance | `sequence.insertClip(projectItem, time, vTrackIndex, aTrackIndex)` | `time` is documented as *"Integer or Time object... a new time in seconds"* — simpler than UXP's mandatory `TickTime` construction. |
| Import a `.mogrt` file directly and insert it | `sequence.importMGT(path, time, vTrackIndex, aTrackIndex)` | `time` here is documented as a **String, in ticks** (not seconds) — inconsistent with `insertClip` above; the POC constructs a `Time` object and reads `.ticks` to get that string, per `Time.ticks` in the docs. |
| Current playhead position | `sequence.getPlayerPosition()` | Returns a `Time` object. |
| Move a clip | `trackItem.move(newInPoint)` — `newInPoint` is seconds | |
| Clip start/end (duration) | `trackItem.start`, `trackItem.end` — read/write | Setting `end = start + 2` gives a 2-second duration. |
| MOGRT's component directly | `trackItem.getMGTComponent()` | Skips walking `.components` when the track item is known to be a MOGRT. |
| Walk components/params | `trackItem.components[i]` (`ComponentCollection`, `.numItems`) → `.properties[j]` (`ComponentParam`) | Same shape as UXP's `Component`/`ComponentParam.getParam(i)`. |
| Read/write a non-time-varying param | `param.getValue()` / `param.setValue(value, updateUI)` | The candidate under test. |

**No documented "duplicate an existing clip" API was found** (searched the
official guide directly; zero results for `TrackItem.duplicate`). The
grounded approach — and the one both this project's existing UXP code and
the ExtendScript docs above point to — is inserting a **new instance** from
a `ProjectItem`/`.mogrt` source each time, not literally duplicating a
`TrackItem`. The proof of concept below does that.

## Part 4: the UXP↔CEP bridge — design, explained before implementation

CEP and UXP are separate extension runtimes inside Premiere Pro. **There is
no documented API for one to call the other directly.** Two further,
load-bearing facts, both confirmed rather than assumed:

1. **UXP cannot host a network server — only act as a client.** This is a
   real, documented architectural limit (confirmed via
   [mikechambers/adb-mcp](https://github.com/mikechambers/adb-mcp), a public,
   working project that bridges AI tooling into Photoshop/Premiere/After
   Effects through exactly this constraint: *"the public facing API for UXP
   based JavaScript plugin does not allow it to listen on a socket connection
   (as a server)"*). UXP's `fetch()`, however, works fine as an outbound
   client call.
2. **CEP panels can run a local Node.js server**, when the manifest opts in.
   Adobe's own CEP documentation and blog ("How to Build a Node.js Server in
   a Panel") describe enabling Node.js integration via
   `--enable-nodejs --mixed-context` in the manifest's `CEFCommandLine`
   parameters. `--mixed-context` specifically means the *same* panel script
   gets both Node.js APIs (`require`, `http`) **and** browser/DOM APIs
   (`CSInterface`, `evalScript`) in one JS context — no separate hidden
   background extension is required for a small internal tool like this one.

Given those two facts, the minimal, correct bridge is:

```
UXP panel (fetch, client only)  --HTTP-->  CEP panel (Node http.createServer, mixed-context)
                                                  |
                                                  v
                                     CSInterface.evalScript(jsx)
                                                  |
                                                  v
                                     ExtendScript running inside
                                     the actual Premiere Pro host
                                                  |
                                                  v
                            JSON.stringify(result) returned via evalScript callback
                                                  |
                                                  v
                              Node HTTP handler resolves the pending
                              HTTP response with that JSON
```

This is the same core pattern `adb-mcp` uses (`AI ↔ MCP Server ↔ Command
Proxy Server ↔ UXP Plugin ↔ App`), simplified because we don't need to reach
outside the local machine — no external proxy process is needed, since the
CEP extension itself can be the server, right where UXP needs it: `localhost`.

**Why HTTP request/response, not WebSocket:** every command in this
workflow (create graphic, set text, set timing) is a single request →
single response — there's no need for a persistent duplex connection or
server-initiated push. Plain HTTP is simpler to implement, simpler to
reason about for timeouts, and needs no extra library (Node's built-in
`http` module is enough; `adb-mcp` used WebSocket because it also had to
solve server-initiated push and multi-client fan-out, neither of which
applies here).

**Request/response contract:**

```jsonc
// POST http://127.0.0.1:<port>/command   (UXP -> CEP)
{
  "command": "createTextGraphic",
  "payload": { "mogrtPath": "...", "text": "__KERIS_CEP_TEST__", "durationSec": 2, "videoTrackIndex": 0 },
  "requestId": "a uuid, for correlating logs on both sides"
}
```

```jsonc
// 200 OK, always — application-level failures are reported in the body,
// not via HTTP status, so UXP has one uniform shape to parse regardless
// of what went wrong.
{
  "ok": true,
  "requestId": "same uuid echoed back",
  "result": { "trackItemName": "...", "start": 12.0, "end": 14.0, "sourceTextWriteOk": false, "sourceTextWriteError": "..." }
}
// or
{ "ok": false, "requestId": "...", "error": "message", "stack": "..." }
```

**Timeout handling (UXP side):** `fetch()` with an `AbortController`, default
8s (matches this project's existing `DEFAULT_ROUND_TRIP_BUDGET_MS`
convention). If the CEP bridge isn't running at all, `fetch()` itself
rejects immediately (connection refused) — reported as "CEP bridge
unavailable," distinct from a timeout, so the UI can tell a user "the CEP
panel isn't open" apart from "it hung."

**Error propagation:** every failure mode — CEP not running, the HTTP call
itself failing, a non-JSON response, `evalScript` throwing, the ExtendScript
command itself failing — is caught and normalized into the same
`{ok:false, error, step}` shape this project's UXP diagnostics already use
throughout `src/ppro/*.js`, so the existing panel/log conventions apply
unchanged.

## Part 5: what's in this repo now

- `cep-bridge/` — a new, separate CEP extension. Does **not** touch
  `src/`, `manifest.json`, or `dist/main.js` — the existing UXP extension is
  completely unaffected and still installs/runs exactly as before.
  - `CSXS/manifest.xml` — targets `PPRO`, enables Node.js + mixed context.
  - `client/CSInterface.js` — Adobe's official, unmodified library (copied
    verbatim from `Adobe-CEP/CEP-Resources`, the standard, Adobe-provided way
    every CEP extension includes this file).
  - `client/index.html` / `client/main.js` — the Node HTTP server +
    `evalScript` dispatch described above.
  - `jsx/hostscript.jsx` — the ExtendScript command implementations, using
    only the documented APIs in Part 3's table.
  - `.debug` — required for loading an unsigned, in-development CEP
    extension (`PlayerDebugMode` registry/plist flag — see `README.md`).
  - `README.md` — setup and test instructions specific to this experimental
    piece.
- `src/ppro/cepBridge.js` — the UXP-side client: `callCepBridge(command,
  payload, opts)`, timeout/error handling as specified above.
- `src/ui/cepBridgePanel.js` — a small, clearly-labeled "CEP Bridge
  (experimental)" section with the one proof-of-concept button, wired into
  the existing panel via `src/ui/render.js`.

## Part 6: what this is not (yet)

This is a proof of concept for **one** capability question — can
`ComponentParam.setValue()` succeed where `createSetValueAction()` didn't —
not a rebuild of the product. No caption-generation logic changed. If the
proof of concept's `setValue()` call also fails (the evidence-grounded
expectation from Part 2), that is itself the answer to the product question:
native Premiere MOGRT Source Text is very likely not writable through either
currently-documented Adobe scripting surface, on this specific MOGRT/param,
and that needs to be reported plainly rather than routed around with more
probing.

## Part 7: first real-host run — `importMGT()` multi-video-track detection bug

**Confirmed real-host bug report:** on a sequence with 13+ video tracks,
the POC reported `"importMGT() did not appear to add a clip to video track
0 (clip count unchanged: 17)"`. `createTextGraphic()`'s original
implementation hard-coded `videoTrackIndex` to `0` whenever the UXP payload
didn't explicitly set one (`src/ppro/cepBridge.js`'s `testCepWriteProof`
also independently hard-coded its own default to `0`, so `0` is what always
got sent), and only ever checked *that one track's* clip count before/after
the call to decide whether insertion succeeded. Track 0 already had 17
clips before the call and 17 after — true, but uninformative: `importMGT()`
did not throw, and the clip may well have landed on any of the sequence's
other 12+ video tracks. The old check never looked anywhere else.

**Fix (`cep-bridge/jsx/hostscript.jsx`):**
- `videoTrackIndex` resolution never falls back to a literal `0` anymore.
  If the caller's requested index is missing or out of range, it falls back
  to the **topmost** video track (`videoTrackCount - 1`) — matching the
  convention the UXP MOGRT-insertion path already uses
  (`src/ppro/timelineRange.js`'s `listVideoTracks()` callers).
- `audioTrackIndex` is resolved and validated independently against
  `audioTrackCount` — never assumed equal to `videoTrackIndex` (the same
  class of bug already fixed on the UXP side; see `src/ppro/mogrt.js`'s
  `resolveAudioTrackIndex()`).
- Every video track is snapshotted (clip count + each clip's name/start/end)
  both **before** and **after** `importMGT()` runs, via
  `snapshotAllVideoTracks()`.
- The inserted clip is located via a three-tier cascade, each tier checking
  every video track, never a single fixed index:
  1. `importMGT()`'s own return value, if it looks like a `TrackItem`
     (`looksLikeTrackItem()`).
  2. `findNewClipAcrossTracks()` — diff every track's clips before vs.
     after by `(name, start)`; the first clip present after but absent
     before, on *any* track.
  3. `findClipByTimeAndName()` — last resort: a clip within 1s of the
     requested insertion time whose name contains the MOGRT's base
     filename, again across every track.
- Insertion is only reported as a failure once **all three tiers** have
  been checked and none found a clip; the failure response includes
  `beforeClipCounts`/`afterClipCounts` (one entry per video track) so the
  full picture is visible, not just track 0's.
- `result.diagnostics` (an ordered array of log lines) now always
  accompanies the response — active sequence name, video/audio track
  counts, resolved track indexes and why, requested insertion time in both
  seconds and ticks, before/after per-track clip counts as JSON,
  `importMGT()`'s return type + a shallow safe description of its value,
  and the detection tier + track index that found the clip. On success the
  response also carries `detectedTrackIndex`, `detectionMethod`,
  `importReturnType`, `requestedVideoTrackIndex`, and
  `requestedAudioTrackIndex` directly on `result` for quick inspection
  without opening `diagnostics`.
- `src/ppro/cepBridge.js`'s `testCepWriteProof()` no longer hard-codes
  `videoTrackIndex: 0` either. It now resolves the real topmost video track
  on the UXP side first (`resolveTopVideoTrackIndexForCep()`, using the
  same `requireActiveProjectAndSequence()` + `listVideoTracks()` helpers
  every other UXP diagnostic in this project already uses) and only
  includes `videoTrackIndex` in the payload if that resolves to a real
  number — otherwise the field is omitted entirely and the ExtendScript
  side's own independent topmost-track fallback takes over. Neither side
  can silently default to `0` anymore.
- `src/ui/cepBridgePanel.js` now renders `result.diagnostics` in a
  collapsible `<details>` block, plus the detected-track/detection-method/
  import-return-type/requested-track summary line, on both the success and
  failure paths (including `beforeClipCounts`/`afterClipCounts` on
  failure).
- `test/cepHostScript.test.js` adds static regression checks (source-text
  assertions, following `test/entrypoint.test.js`/`test/mogrt.test.js`'s
  established pattern — `hostscript.jsx` can't run under Node, only
  ExtendScript, so these check the file's source rather than executing it)
  that specifically prevent the hard-coded-track-0 pattern from
  reappearing, and confirm the multi-tier detection helpers are present and
  genuinely iterate `sequence.videoTracks.numTracks`.

**What is still unverified:** all of the above is grounded in the exact bug
report and the same evidence-based discipline as every other fix in this
project, but it has not yet been re-run against a live Premiere host by
this agent (no host access in this environment). The next live run's
`result.diagnostics` / `detectedTrackIndex` / `detectionMethod` will show
definitively which track `importMGT()` actually used and whether
`ComponentParam.setValue()` on Source Text succeeded — that is the
information this fix was built to surface, not assume.

## Part 8: second real-host run — insertion confirmed working; deep, read-first Source Text investigation

**Confirmed real-host result (breakthrough):** the Part 7 fix worked.
`importMGT()` succeeds, the MOGRT lands on the expected top video track
(Premiere's UI shows `V13`; the 0-based API index `12` is correct — the
topmost-track fallback from Part 7 resolved exactly right), and the
inserted graphic briefly displays its default text, `"Hello World"`.
**Insertion is solved.** The only remaining open question is what shape
`ComponentParam.getValue()`/`.setValue()` actually use for that visible
text — not whether insertion works.

Rather than keep guessing at `setValue()` argument shapes (raw string —
already confirmed to throw `"Illegal Parameter type"`, see
`docs/MOGRT_DIAGNOSTIC.md`), this round adds a **read-first** diagnostic,
`probeSourceTextDeep()`, that never calls `setValue()` until the read path
(`getValue()` and the param's own shape) is fully understood from evidence.

**Grounding for the introspection technique:** ExtendScript host object
properties (like `ComponentParam`'s) are typically **not** enumerable via
plain `for...in` — the documented, reliable way to enumerate them is the
built-in **ExtendScript Reflection Interface** (Adobe's *JavaScript Tools
Guide*, "ExtendScript Reflection Interface" section): every ExtendScript
object exposes `.reflect`, a `ReflectionObject` with `.name` (class name),
`.properties` (array of `{name, dataType, type}`), and `.methods` (array of
`{name, arguments}`). Note: Adobe's own developer community has documented
cases (After Effects) where `.type` reports `"readwrite"` for a property
that is actually read-only at write time — so `.reflect`'s `.type` field is
treated as informational only here; every read and every write in
`probeSourceTextDeep()` stays wrapped in `try/catch` regardless of what
`.type` claims.

**What `cep-bridge/jsx/hostscript.jsx`'s new `probeSourceTextDeep()` command does,
in order — never skipping ahead to a write:**
1. Inserts the given `.mogrt` and locates the inserted clip using the exact
   same track-resolution + three-tier detection as `createTextGraphic()`
   (Part 7) — insertion is a solved problem now, so this reuses it as-is
   rather than re-solving it.
2. Enumerates every component/param `displayName` on the clip
   (`componentAndParamNamesSeen`), so if `"Source Text"` isn't found by
   that exact name, the response shows exactly what *was* found instead of
   just failing silently.
3. Once located, dumps **everything reflect-visible about the param itself**
   (`result.paramDump`, via the new `dumpValueDeep()` helper — recursively
   walks `.reflect.properties`/`.methods`, reading each property's live
   value, bounded by depth/node-count/array-length limits so a
   self-referential host object graph can't hang the script or blow up the
   evalScript payload), plus `paramMatchName`, `paramDisplayName`,
   `paramTypeofSelf`, `paramConstructorName` — **before `getValue()` is
   ever called.**
4. Calls `getValue()` exactly once for the initial read. If it throws, the
   response records `getValueThrew: true`, `getValueThrowLocation`
   (a human-readable description of exactly which call site), the error
   message, and — where ExtendScript's `Error.line` is available — the
   line number, then returns immediately without attempting anything else.
5. On success, dumps the **complete** `getValue()` return value the same
   way (`result.getValueDump`), records `typeof` (`getValueRawType`), and —
   if it's a string — attempts `JSON.parse()` on it to check whether it's
   actually JSON underneath.
6. Classifies the shape into `structuredKind`: `"plain-object"` (a real
   plain JS object), `"json-string"` (a string that parses as JSON),
   `"host-object-with-reflect"` (a *live* ExtendScript host object — not
   plain data), or `"none"` (primitive/null/undefined).
7. Searches the structured shape (whichever of the three above it is) for
   field **names** suggesting they hold visible text —
   `textEditValue`, `fontTextRunLength`, `text`, `value`, `string`,
   `content`, `run`, and any nested match, at any depth — recording every
   candidate's full path, key, and a value preview
   (`result.textFieldCandidates`), never assuming any single name is *the*
   answer up front.
8. **Only if** `structuredKind` is `"plain-object"` or `"json-string"`
   **and** at least one text-like field was found does it attempt a write:
   clones the structure (JSON round-trip — safe, since by this point it's
   already a plain, JSON-safe value, never the live host object), modifies
   *only* the chosen field (preferring an exact `textEditValue` match, then
   `text`, then the first non-empty string candidate), and calls
   `setValue()` with the modified structure — a JSON string if the
   original was a JSON string, a plain object otherwise. A live
   `"host-object-with-reflect"` value is **deliberately never** used to
   fabricate a write — there is no evidence a hand-built plain copy is what
   `setValue()` expects for a live host type, so that case is reported
   (with its full dump) but not written to.
9. Reads back via `getValue()` again (same throw-location discipline as
   step 4, under `readBackThrew`/`readBackThrowLocation`), dumps the result
   (`result.getValueDumpAfter`), and produces a **complete, bounded,
   leaf-level before/after diff** (`result.beforeAfterDiff`, via the new
   `diffDumpedTrees()` helper) between the pre-write and post-write
   structures.

**UXP/UI side:**
- `src/ppro/cepBridge.js` adds `probeSourceTextDeep(opts)` — same
  reachability-check-then-command pattern as `testCepWriteProof()`, calling
  the `"probeSourceTextDeep"` host command with `{mogrtPath, newTextValue,
  videoTrackIndex?}`; `videoTrackIndex` is resolved the same
  never-hard-code-0 way as Part 7 (`resolveTopVideoTrackIndexForCep()`).
- `src/ui/cepBridgePanel.js` adds a second button, "Probe Source Text
  (deep, read-first)", rendering the param dump, the `getValue()` dump, the
  text-field candidates, the write-test outcome (or a clear explanation of
  why no write was attempted), and the full before/after diff — each large
  JSON blob in a collapsible `<details>` block so the panel stays readable.
- `test/cepBridge.test.js` and `test/cepHostScript.test.js` add coverage:
  the client function's request shape/gating, and static regression checks
  that `probeSourceTextDeep()` (a) is wired into `dispatch()`, (b) uses
  `.reflect.properties`/`.reflect.methods` rather than a blind `for...in`,
  (c) calls `getValue()` and dumps its result strictly before any
  `setValue()` call is reached in the function body, (d) only attempts
  `setValue()` when `structuredKind` is `"plain-object"` or
  `"json-string"` — never for a live host object or a blind raw-string
  guess, (e) computes a real before/after diff via a dedicated helper, and
  (f) records exactly where `getValue()` threw on both the initial read
  and the post-write read-back.

**What is still unverified:** as with every prior round, this has not yet
been run against a live Premiere host by this agent (no host access here).
The next live run's `result.paramDump`, `result.getValueDump`,
`result.structuredKind`, `result.textFieldCandidates`, and — if a write was
attempted — `result.sourceTextWriteOk`/`result.beforeAfterDiff` will show,
with evidence, exactly what Premiere stores for native graphic text and
whether `ComponentParam.setValue()` can change it. That is what this
diagnostic exists to surface, not assume.
