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

## Part 9: third real-host run — an internally inconsistent probe result; byte-level Source Text inspection

**Confirmed real-host anomaly report:** a `probeSourceTextDeep()` run found
the Source Text param, `getValue()` succeeded, `typeof` the result was
`"string"`, the UI's rendered preview of that string *looked like* `"{}"`,
but the same result also said `JSON.parse()` failed and classified the
shape as `structuredKind: "none"`. Those two facts don't fit together: if
the string really were exactly the two characters `{}`, `JSON.parse()`
would succeed. Something about the string's actual bytes doesn't match
what its rendered preview showed — a leading UTF-8 BOM, embedded null
characters, surrounding whitespace, or non-printing characters are all
things a casual preview can hide but that break `JSON.parse()`.

Rather than guess at `setValue()` shapes against a string that isn't fully
understood, this round adds a byte-level diagnostic,
`inspectSourceTextRawBytes()`, that answers the anomaly with hard evidence
instead of another API experiment.

**What `cep-bridge/jsx/hostscript.jsx`'s new `inspectSourceTextRawBytes()`
command does** (reuses `createTextGraphic()`/`probeSourceTextDeep()`'s
track resolution + three-tier clip detection to insert and locate the
clip and its Source Text param — insertion is solved, so this doesn't
re-solve it — then, once `getValue()` succeeds and returns a string):

1. **Exact string length** — `rawValue.length`.
2. **`JSON.stringify(rawValue)`** — the single most revealing check here:
   `JSON.stringify()` escapes control characters, the BOM, and anything
   else invisible in a plain rendered preview into visible `\uXXXX`
   sequences.
3. **Every character code + hex value** — `charCodeHexDump()`, one entry
   per character (`{index, char, code, hex}`), bounded to 4000 characters
   (`charCodeDumpTruncated` reports if the real string is longer).
4. **First and last 32 characters, logged separately** — `first32`/
   `last32`, plus their own char-code dumps.
5. **`JSON.parse(rawValue)`** wrapped in `tryJsonParse()`, which captures
   the exact thrown message, best-effort parses a character position out
   of that message (`/position\s+(\d+)/i` — ExtendScript's JSON
   implementation doesn't expose a structured position field, only prose),
   and `Error.line` where available.
6. Four more `tryJsonParse()` attempts against normalized variants:
   `rawValue.trim()` (falling back to a manual regex trim if
   `String.prototype.trim()` is unavailable on this ExtendScript engine —
   logged either way), a UTF-8-BOM-stripped copy (`hasUtf8Bom` checks
   `charCodeAt(0) === 0xfeff`), a null-character-stripped copy
   (`hasNullCharacters` checks for `\u0000`), and a fully-normalized copy
   (all three combined) — `result.isValidJsonAfterNormalization` reports
   whether that last, most-permissive attempt succeeded.
7. **Never calls `setValue()`** — this command has no write path at all.
8. Every step above is also pushed to `result.diagnostics` as a readable
   log line.
9. **Saves the complete result to a JSON file** via `saveDiagnosticJson()`
   — ExtendScript's documented `File`/`Folder` API, writing to
   `Folder.temp.fsName + "/caption-studio-source-text-raw-dump.json"` —
   in addition to returning it over the bridge; `result.savedDiagnosticFile`
   reports the saved path (or the write error, non-fatally).

**A real bug this diagnostic's own development caught:** while first
writing the null-character-stripping logic, a literal NUL byte was
accidentally embedded directly in `hostscript.jsx`'s source (instead of
the intended `\u0000` escape sequence) — caught by `file
cep-bridge/jsx/hostscript.jsx` reporting the file as non-text/binary
immediately after the edit, and by `grep` matching it as a "binary file".
Fixed by replacing the literal NUL bytes with proper `\u0000` escapes
before this was ever committed. `test/cepHostScript.test.js` now has a
dedicated regression test (`hostscript.jsx contains no literal NUL
bytes...`) reading the file as a raw buffer and asserting no `0x00` byte
exists, so this specific corruption can't silently reappear.

**UXP/UI side:**
- `src/ppro/cepBridge.js` adds `inspectSourceTextRawBytes(opts)` — same
  reachability-check-then-command pattern as the other two CEP entry
  points, calling the `"inspectSourceTextRawBytes"` host command with
  `{mogrtPath, videoTrackIndex?}` (no text/duration fields — this
  diagnostic doesn't write anything).
- `src/ui/cepBridgePanel.js` adds a third button, "Inspect Source Text Raw
  Bytes", rendering the exact length, `JSON.stringify()` output, first/last
  32 characters, BOM/null-character flags, the full character-code dump
  (collapsible), all five `JSON.parse()` attempts with their outcomes, the
  final normalized-validity verdict, and the saved-file path.
- `test/cepBridge.test.js` and `test/cepHostScript.test.js` add coverage:
  the client function's request shape/gating (no text/duration fields sent,
  same never-hard-code-track-0 convention), and static regression checks
  that `inspectSourceTextRawBytes()` is wired into `dispatch()`, never
  calls `setValue()` anywhere in its body, performs each of the specific
  byte-level checks above, and that the file itself stays clean UTF-8 text.

**What is still unverified:** as with every prior round, this has not yet
been run against a live Premiere host by this agent. The next live run's
`result.charCodeDump`, `result.jsonStringifyOfRawValue`, and
`result.jsonParseAttempts` will show, with byte-level evidence, exactly
what `getValue()` returns and why it wasn't parsing as JSON — the specific
question this diagnostic exists to answer before any further `setValue()`
experiments are attempted.

## Part 10: fourth real-host run — "EvalScript error." instead of a JSON failure; ExtendScript-engine hardening

**Confirmed real-host bug report:** `inspectSourceTextRawBytes()` failed
immediately with `Non-JSON response from ExtendScript: EvalScript error.`,
while `probeSourceTextDeep()` continued to work fine. That literal string,
`"EvalScript error."`, is CEP's own `evalScript()` fallback for a fault
inside the ExtendScript engine that escapes normal script-level
`try/catch` — meaning the exception was happening somewhere `dispatch()`'s
own wrapping `try/catch` (which normally always returns valid JSON, even
on failure) never got a chance to catch.

**What this investigation confirmed and what it couldn't confirm:**
- A full static audit of `inspectSourceTextRawBytes()`'s source against
  every specific unsupported-feature suspect the bug report listed
  (`String.prototype.codePointAt`/`startsWith`/`endsWith`,
  `Array.prototype.map`/`filter`/`reduce`, `let`/`const`, arrow functions,
  template literals, `Object.keys` on host objects) found **none of them
  present** — the function was already ES3/ES5-safe on every one of those
  specific points.
- However, a **real, separately-confirmed bug** was found and fixed while
  auditing this exact function: this project's own tooling had twice
  (see Part 9) accidentally written a literal NUL byte into
  `hostscript.jsx`'s source instead of the intended null-character escape
  sequence — direct, first-hand evidence that escape-sequence handling
  around this specific character is genuinely unreliable in this toolchain
  right now. Since the bug report explicitly names "Unicode escape
  handling that ExtendScript may parse differently" as a suspect, and this
  project's own editing tools independently demonstrated exactly that kind
  of unreliability on the identical character, the null-character/BOM
  handling in `inspectSourceTextRawBytes()` was rewritten from
  `/\` + `u0000/g` regex literals to a plain `stripNullChars()` helper
  (character-by-character loop, `charCodeAt(i) !== 0`) and
  `String.fromCharCode(0)` construction — removing every escape-sequence
  literal of that kind from the file entirely, so there is nothing left
  for either toolchain to potentially mis-encode.
- The single operation unique to `inspectSourceTextRawBytes()` that
  `probeSourceTextDeep()` (still working) never performs is the temp-file
  write (`saveDiagnosticJson()`, via `File`/`Folder`) — the prime
  remaining suspect for an engine-level fault outside normal `try/catch`,
  though this is a hypothesis, not a confirmed cause.
- **This agent has no live Premiere host access**, so which of these (if
  any) was the actual root cause could not be directly confirmed here —
  the changes below are the grounded mitigation plus the tooling needed to
  pin it down definitively on the next real-host run.

**Hardening (`cep-bridge/jsx/hostscript.jsx`):**
- `inspectSourceTextRawBytes()`'s ENTIRE body now runs inside one
  top-level `try { ... } catch (fatalErr) { return buildFatalFailure(...); }`
  — every normal catchable exception, no matter where it happens, now
  always returns a plain JS object instead of letting anything escape past
  `dispatch()`'s own `JSON.stringify(response)`.
- A `stage` variable is set right before each phase begins —
  `argument-parsing`, `mogrt-insertion`, `source-text-lookup`,
  `raw-string-inspection`, `json-serialization`, `temp-file-writing` — and
  `buildFatalFailure(requestId, stage, diagnostics, err)` returns
  `{ok: false, stage, error, errorLine, errorFileName, errorStack, diagnostics}`
  on any fatal exception, using ExtendScript's own `Error.line`/
  `.fileName`/`.stack` where available. On the next live run: if this
  wrapper is reached and a `stage`-tagged JSON response comes back, the
  fault was a normal catchable exception at that exact stage; if
  `"EvalScript error."` still comes back with **no JSON at all**, the
  fault is happening below the JS engine's own catch mechanism entirely —
  strong evidence for the temp-file-write hypothesis above.
- `payload.skipFileSave` (new, optional): when true, `temp-file-writing`
  is skipped entirely and the byte-level result is still returned in full
  — lets the next live run test the temp-file-write hypothesis directly by
  running the diagnostic twice, once normally and once with this flag set.
- **New standalone command, `testRawBytesHelpers()`** (task 8): exercises
  the exact same `charCodeHexDump()`/`tryJsonParse()`/`JSON.stringify()`
  helpers against a built-in dummy string (a BOM, an embedded null
  character, and surrounding whitespace around `"{}"`, reproducing the
  Part 9 anomaly on purpose) — with **zero Premiere host object access**:
  no `app.project`, no `activeSequence`, no `importMGT`, no `getValue`/
  `setValue`. If this command also fails with `"EvalScript error."`, the
  fault is in the byte/JSON string-processing logic itself; if it
  succeeds, the fault is specifically in the MOGRT-insertion/
  Source-Text-lookup/file-I/O path that `inspectSourceTextRawBytes()`
  layers on top of it.
- `stripNullChars(s)` (new helper): replaces every prior null-character
  regex/escape-literal usage, as described above.

**UXP/UI side:**
- `src/ppro/cepBridge.js` adds `skipFileSave` support to
  `inspectSourceTextRawBytes()` (only included in the payload when
  explicitly truthy) and a new `testRawBytesHelpers(opts)` client function
  — the latter doesn't even require a `.mogrt` path, since the host
  command it calls never touches one.
- `src/ui/cepBridgePanel.js` adds a "Skip temp-file writing" checkbox next
  to the raw-bytes button, and a fourth button, "Run Byte/JSON Helper
  Self-Test (no Premiere objects touched)", rendering the self-test's
  result the same way as the raw-bytes inspection. Both the raw-bytes and
  self-test failure views now surface `stage`/`errorLine`/`errorFileName`/
  `errorStack` when present.
- `test/cepBridge.test.js` and `test/cepHostScript.test.js` add coverage:
  the two new client functions' request shape/gating, and static
  regression checks that (a) the top-level try/catch and all six stage
  markers are present and used, (b) `buildFatalFailure()`'s exact return
  shape, (c) `testRawBytesHelpers()` never references `app.project`,
  `activeSequence`, `importMGT`, `getValue`, or `setValue`, (d) no
  null-character escape-sequence literal exists anywhere in the file
  anymore (only `stripNullChars()`/`String.fromCharCode(0)`), and (e) a
  broader ES3-compatibility sweep blocking `startsWith`/`endsWith`/
  `codePointAt`, `Array.prototype.map`/`filter`/`reduce`, `Object.keys`,
  template literals, `const`/`let`, and arrow functions from ever
  reappearing in this file.

**What is still unverified:** whether this actually resolves the
`"EvalScript error."` on a live host, and — if it doesn't — exactly which
`stage` (if a JSON response comes back at all) or which of the two
isolation tools (`skipFileSave`, `testRawBytesHelpers`) narrows it down.
This agent has no live Premiere host access in this environment; the next
real-host run of "Inspect Source Text Raw Bytes" and "Run Byte/JSON Helper
Self-Test" will show, with direct evidence, exactly where in the pipeline
the fault actually is.

## Part 11: fifth real-host run — the self-test fails too; bisection instead of more diagnostics

**Confirmed real-host result that changes the diagnosis:**
`testRawBytesHelpers()` — the standalone self-test built in Part 10
specifically to touch zero Premiere APIs — ALSO fails with the same
non-JSON `Non-JSON response from ExtendScript: EvalScript error.`. Since
this command never references `app.project`, `activeSequence`, any MOGRT,
or any file I/O, the fault cannot be in Premiere-object handling or
temp-file writes — it is somewhere in `hostscript.jsx`'s own code, most
likely one of the string/JSON helpers this command shares with
`inspectSourceTextRawBytes()` (`charCodeHexDump`, `tryJsonParse`,
`stripNullChars`) or something about how those functions/the new
top-level `STAGE_*` constants are declared.

**Why more diagnostics wouldn't help, and bisection is the right move:**
Every prior round added MORE code (more dumping, more stage tracking, more
try/catch) — but if the fault is a genuine parse/compile-level problem in
one specific statement, adding more code around it doesn't help find it,
and can't be caught by try/catch at all if it's not a normal runtime
exception. Per the user's explicit instruction, this round adds no new
diagnostics — instead, `bisectHostScript()` isolates the exact breaking
statement by testing exactly one incremental addition at a time, letting
the next live-host run pinpoint it directly rather than guessing further.

**`cep-bridge/jsx/hostscript.jsx`'s new `bisectHostScript(payload, requestId)`
command** — `payload.step` (0–11) selects how much code runs; every step
returns immediately, so no step ever executes more than the one construct
it specifically tests:

| Step | Tests |
| --- | --- |
| 0 | Return a minimal plain object — identical in shape to the already-confirmed-working `"ping"` command. If THIS fails, the fault is in `dispatch()`'s routing to a new command branch, not in any of the code below. |
| 1 | Return a plain object with one added field. |
| 2 | `var s = "{}";` — declare a short string literal. |
| 3 | `var len = s.length;` — read `.length`. |
| 4 | `JSON.stringify(s)` — stringify the string itself. |
| 5 | A `charCodeAt()` loop — the core of `charCodeHexDump()`, written out inline. |
| 6 | Hex conversion (`.toString(16)`) + a string-padding `while` loop — the rest of `charCodeHexDump()`'s logic, still inline. |
| 7 | Call the REAL `charCodeHexDump()` helper directly. |
| 8 | A bare `JSON.parse()` in `try`/`catch` — the core of `tryJsonParse()`. |
| 9 | Call the REAL `tryJsonParse()` helper directly. |
| 10 | Call the REAL `stripNullChars()` helper directly. |
| 11 | Call the REAL `testRawBytesHelpers()` command function directly — the exact function that fails on the live host today. |

Never references `app.project`/`activeSequence`/`importMGT` at any step
(task 5) — consistent with the confirmed finding that Premiere APIs are
not where the fault is. The whole function is wrapped in its own
top-level `try`/`catch` too, tagging any normal catchable exception with
`"bisect-step-N"` via the same `buildFatalFailure()` used elsewhere — but
per the working theory below, the actual fault may not be a normal
catchable exception at all.

**Working theory (not confirmed — this agent has no live host access):**
older JS engines with lazy/deferred per-function compilation can parse a
file's overall structure (function boundaries, top-level statements)
successfully at load time, while a genuine syntax-level problem *inside*
one specific function's body isn't discovered until that function is
first invoked. This would explain every observed fact simultaneously:
`dispatch()`, `"ping"`, `createTextGraphic()`, and `probeSourceTextDeep()`
all continue to work (the file's overall structure parses fine); a fault
specific to `testRawBytesHelpers()`/`inspectSourceTextRawBytes()`/their
shared helpers only surfaces when one of those is actually called; and it
isn't caught by any `try`/`catch` — script-level or `dispatch()`'s own —
because a deferred compile-time fault isn't a normal runtime exception. If
this theory is right, `bisectHostScript()`'s steps 5 through 10 are
exactly the ones capable of finding it, since they're the first point
where each new construct is exercised in isolation.

**UXP/UI side:**
- `src/ppro/cepBridge.js` adds `bisectHostScript({log, step})` — same
  reachability-check-then-command pattern as the other CEP entry points;
  doesn't require a `.mogrt` path.
- `src/ui/cepBridgePanel.js` adds a step number input (0–11) and two
  buttons — "Run Bisect Step N" and "Run Bisect Step, Then Advance" (which
  auto-increments the step only after a successful result) — rendering
  each step's raw result or, on failure, the same `stage`/`errorLine`/
  `errorFileName`/`errorStack` fields the hardening in Part 10 added.
- `test/cepBridge.test.js` and `test/cepHostScript.test.js` add coverage:
  the client function's request shape, and static regression checks that
  `bisectHostScript()` is wired into `dispatch()`, never references
  `app.project`/`activeSequence`/`importMGT`, that step 0 matches
  `"ping"`'s shape, that every requested construct (steps 2 through 11) is
  present in the right order, and that each step's `if` block stays small
  (a structural proxy for "tests exactly one new thing").

**What this run cannot answer without live-host access:** which step is
the first to fail. Run step 0 first to confirm the baseline works, then
advance one step at a time (or use "Run Bisect Step, Then Advance," which
stops auto-advancing the moment a step fails) — the first step whose
result is the raw `"EvalScript error."` string instead of a JSON result is
the exact breaking statement, and its step number directly identifies
which construct (a plain string operation, a specific helper function, or
something about how these functions/constants are declared in the file)
is the true root cause.

## Part 12: sixth real-host run — bisection step 0 fails too; this is dispatch/registration, not code

**Confirmed real-host result that redirects the whole investigation:**
`bisectHostScript()`'s **step 0** — a bare `return { ok: true, ... }`, no
string/JSON helpers, no Premiere APIs, structurally identical to the
already-confirmed-working `"ping"` command — fails immediately with the
same non-JSON `"EvalScript error."`. Meanwhile `ping`, `createTextGraphic`,
and `probeSourceTextDeep` all keep working. Since step 0 rules out every
JavaScript-compatibility hypothesis from Parts 9–11 (there is no string
manipulation, no JSON parsing, no character-code logic — the theories this
investigation had been chasing), the fault cannot be in what any of these
new commands' code *does*. It has to be in whether that code is actually
being *reached* at all.

### Task 1: the complete working path, `probeSourceTextDeep` vs. `bisectHostScript`

| Layer | `probeSourceTextDeep` (confirmed working) | `bisectHostScript` (confirmed failing, even step 0) |
| --- | --- | --- |
| UXP request command name | `"probeSourceTextDeep"` | `"bisectHostScript"` |
| CEP Node server routing (`client/main.js`) | `handleCommand()` reads `command` from the POST body and passes it straight through to `runExtendScriptCommand()` — command name is never special-cased. | Identical — `handleCommand()`/`runExtendScriptCommand()` contain no command-specific branching at all. |
| `CSInterface.evalScript()` string construction | `` `$._captionStudioBridge.dispatch(${JSON.stringify(requestJson)})` `` — same template every time, `requestJson` is `JSON.stringify({command, payload, requestId})`. | Byte-for-byte identical construction — only the JSON *content* embedded inside differs (`"command":"bisectHostScript"` vs. `"command":"probeSourceTextDeep"`, `"payload":{"step":0}` vs. a mogrt-path payload). Task 2's new logging (below) makes this directly comparable on the next live run. |
| ExtendScript dispatcher branch | `else if (command === "probeSourceTextDeep") { response = $._captionStudioBridge.probeSourceTextDeep(payload, requestId); }` | `else if (command === "bisectHostScript") { response = $._captionStudioBridge.bisectHostScript(payload, requestId); }` — same `if`/`else if` chain, same shape, defined a few lines below the `probeSourceTextDeep` branch in the same function. |
| Exported/global function visibility | `$._captionStudioBridge.probeSourceTextDeep = function (payload, requestId) { ... };` — a property assignment on the persistent `$._captionStudioBridge` object, at column 0 (true top level, confirmed by this commit's new brace-balance + top-level-scope regression tests). | `$._captionStudioBridge.bisectHostScript = function (payload, requestId) { ... };` — identical pattern, also confirmed top-level and inside a perfectly brace-balanced file. |
| Argument serialization/parsing | `dispatch()` does one `JSON.parse(requestJsonString)`, extracts `.payload`, passes it straight through. | Identical — no per-command parsing differences exist anywhere in `dispatch()`. |
| Return serialization | Command function returns a plain object; `dispatch()` does the one `JSON.stringify(response)` call. | Identical convention (see the new `echoPayload` command's doc comment, which explicitly follows this rather than pre-stringifying, specifically to keep this comparison apples-to-apples). |

**The finding, stated plainly: every layer is structurally identical.**
There is no code-level difference between the working and failing paths
that this comparison — or five previous rounds of static/dynamic
investigation — has found. The only remaining variable is **content**:
`probeSourceTextDeep` existed in `hostscript.jsx` before `bisectHostScript`
did. That points at one specific, well-documented CEP/ExtendScript
behavior, not a bug in this project's code:

**The CEP/ExtendScript caching hypothesis.** Per Adobe's own CEP
architecture, the manifest's `ScriptPath` (`cep-bridge/jsx/hostscript.jsx`)
is evaluated into a persistent ExtendScript "engine" session **once**,
when the extension is first activated in a running Premiere Pro process.
Reopening the CEP panel window reloads `client/index.html`/`client/main.js`
(the browser-side code) — but that is a **separate** reload path from the
ExtendScript engine, and does **not** by itself force the engine to
re-evaluate `hostscript.jsx`. If the live engine loaded this file at some
point before `bisectHostScript`/`testRawBytesHelpers`/
`inspectSourceTextRawBytes` were added (but after `probeSourceTextDeep`
was), every command that existed at that moment keeps working forever
(within that Premiere session), while every command added afterward is
simply **not defined** in the live engine at all — no matter how correct
its code is on disk.

*(One open detail worth flagging honestly: a plain "stale dispatch()"
alone would be expected to hit its own `else` branch and return a clean
`"Unknown command: X"` JSON error, not the opaque `"EvalScript error."`
string — so the precise mechanism inside ExtendScript's engine may be more
specific than a simple stale copy of the whole file. This doesn't change
the recommended fix (force a real reload), but it's why this document
still calls it a hypothesis rather than a certainty this agent can confirm
without live-host access.)*

### What this round adds — verification tools, not more diagnostics (task 8: nothing beyond what was asked)

- **`HOSTSCRIPT_BUILD_ID`** (task 6): a version string constant declared
  near the top of `hostscript.jsx`, bumped on every change to this file.
  Returned in `"ping"`'s result and in the new `"getAvailableCommands"`
  command's result.
- **`SUPPORTED_COMMANDS`**: an explicit array of every real command name
  `dispatch()` routes — also returned by `"ping"` and
  `"getAvailableCommands"`. A new regression test cross-checks this array
  against every `command === "..."` branch actually present in
  `dispatch()`, so it can't silently drift out of date.
- **`getAvailableCommands`** (task 7): a dedicated command for checking
  this independent of `"ping"` (defense in depth, in case `"ping"` itself
  were ever part of a stale load — unlikely, since it's the oldest command
  here, but cheap to guard against).
- **`echoPayload`** (task 3): registered using the *exact same pattern* as
  `probeSourceTextDeep` — a plain function on `$._captionStudioBridge`,
  wired into `dispatch()`'s `if`/`else if` chain the same way, returning a
  plain object (not pre-stringified, to stay apples-to-apples with every
  other command's convention). No helper functions, no Premiere APIs.
  Deliberately placed near the **top** of the file, immediately after
  `dispatch()`/`ping`/`getAvailableCommands` — as structurally far as
  possible from `bisectHostScript` (defined near the very end) — so that
  comparing whether `echoPayload` succeeds while `bisectHostScript` step 0
  fails (or vice versa) is itself diagnostic evidence about *where* in the
  file the live engine's loaded copy stops matching disk.
- **Exact evalScript string logging** (task 2): `client/main.js` now logs
  the full `script` string (the literal text passed to
  `csInterface.evalScript()`) immediately before every call, to both the
  on-panel log and the browser console — enabling a byte-for-byte
  comparison between a working command's call and a failing one's.
- **Automatic startup build check** (task 6): the CEP panel now calls
  `"ping"` automatically the moment its local server starts (no user
  action required) and displays the returned `hostscriptBuildId` +
  `supportedCommands` directly in the panel's status line — so simply
  opening the CEP panel answers "is this a stale engine?" immediately.
- **Structural audit** (task 5, done via static analysis rather than a new
  runtime diagnostic): a brace-balance scanner confirms every `{`/`}` in
  the file matches (zero unmatched braces), and a scope check confirms
  every `$._captionStudioBridge.X = function` handler — including
  `bisectHostScript`, `testRawBytesHelpers`, and
  `inspectSourceTextRawBytes` — sits at column 0 (true top-level/global
  scope, never nested inside another function or after a stray unmatched
  brace). Both are now permanent regression tests
  (`test/cepHostScript.test.js`). **Neither found any problem** — which is
  itself the evidence ruling out "appended outside global scope" as the
  cause and pointing back at engine-level caching.

### What forces a real reload (this is the answer to "must Premiere be restarted")

Based on the CEP/ExtendScript architecture described above: reopening the
CEP panel (closing and reopening the "Caption Studio CEP Bridge" window)
is **not** expected to be sufficient on its own, because it only reloads
the browser-side `client/main.js`, not the ExtendScript engine's loaded
copy of `hostscript.jsx`. **Fully quitting and relaunching Premiere Pro**
is the reliable way to force the ExtendScript engine to start a fresh
session and re-evaluate the `ScriptPath` file from disk. (Some CEP setups
also support forcing a script reload without a full app restart via a
manual `$.evalFile(new File(...))` call against the same engine — not
implemented here, since a full restart is simple, always works, and this
is a scoped proof of concept rather than long-lived tooling.)

**Verification procedure for the next live-host run, in order:**
1. Fully quit Premiere Pro (not just close the project).
2. Pull this branch, `npm run build` in `premiere-caption-graphics/`.
3. Relaunch Premiere Pro, open the project, open the "Caption Studio CEP
   Bridge" panel (Window > Extensions).
4. Watch the panel's own status line/log — the automatic startup ping
   should show `hostscriptBuildId: "2026-07-15-bisect-r2"` (or whatever
   `HOSTSCRIPT_BUILD_ID` is at the time) and list `bisectHostScript`,
   `echoPayload`, etc. in `supportedCommands`.
5. Open the UXP panel, click "Check Bridge Build & Commands" — it should
   report the same build ID and no missing commands.
6. Run `echoPayload` and `bisectHostScript` step 0 — both should now
   succeed with a clean JSON result instead of `"EvalScript error."`.
7. If they still fail after a full Premiere restart, the caching
   hypothesis is disproven and the fault is something neither this round
   nor any prior round has identified yet — report that plainly rather
   than guessing further.

**What this agent could not do:** verify any of the above against a live
Premiere Pro process — no host access in this environment. Every piece of
this round is grounded in Adobe's documented CEP/ExtendScript engine
lifecycle and in ruling out every code-level explanation this
investigation could statically check; whether it's the actual, complete
root cause is what the verification procedure above will show.

## Part 13: seventh real-host run — a full restart didn't fix it either; isolating the invocation layer itself

**Confirmed real-host result that disproves Part 12's leading hypothesis:**
a full Premiere Pro restart — quit and relaunch, per Part 12's exact
verification procedure — did **not** fix `getAvailableCommands`,
`echoPayload`, or `bisectHostScript` step 0. All three still fail with the
same non-JSON `"EvalScript error."` The CEP/ExtendScript engine-caching
theory is ruled out: a fresh engine session, evaluating `hostscript.jsx`
for the first time in that Premiere process, still can't reach these
commands.

**Stop investigating JavaScript compatibility and engine-caching theories
— isolate the invocation layer itself**, per the user's explicit
instruction. This round builds no more hypothesis-driven diagnostics;
instead it adds the minimum tooling needed to answer, empirically, which
exact layer breaks: a pure literal with zero project code, a bare-global
function, or the dispatcher.

### Tasks 1–3: capture, display, and compare the exact evalScript strings

`cep-bridge/client/main.js`'s `runExtendScriptCommand()` now:
- Logs the exact `script` string to both the console and the on-panel
  scrolling log (already true since Part 12), **and**
- Writes it to a new, persistent (non-scrolling) `<pre id="last-eval-script">`
  element in the CEP panel itself (`client/index.html`) — visible without
  opening DevTools, and it stays put after the log scrolls past it.
- Attaches the exact string as `_evalScriptSource` on every resolved
  result object, so the UXP-side panel receives it too, not just the CEP
  panel.

Because every command — working or failing — goes through the exact same
template (`` `$._captionStudioBridge.dispatch(${JSON.stringify(requestJson)})` ``),
the byte-for-byte comparison (task 3) is structural, not something that
varies by command: function/dispatcher name is always
`$._captionStudioBridge.dispatch`, quoting/escaping is always produced by
the same two `JSON.stringify()` calls, payload encoding is always
`{command, payload, requestId}`, parentheses/semicolons are from the same
template literal, and command-string casing is exactly what's passed in
(`"probeSourceTextDeep"`, `"echoPayload"`, `"getAvailableCommands"`,
`"bisectHostScript"` — all correctly camelCased, matching `dispatch()`'s
`command === "..."` checks exactly; confirmed by static comparison, no
typo or casing mismatch found anywhere in this pairing). **The call
construction is not the variable.**

### Task 4/6/7: bypass the dispatcher entirely

New `POST /raw-eval` endpoint (`cep-bridge/client/main.js`) and
`runRawEvalScript()` UXP-side client
(`src/ppro/cepBridge.js`/`src/ui/cepBridgePanel.js`, six preset buttons)
run a **literal** ExtendScript source string directly via
`csInterface.evalScript()`, bypassing `runExtendScriptCommand()`'s
JSON envelope and `dispatch()` completely, and return the **raw callback
result before any JSON parsing** (task 7: exact string, `.length`, and
`JSON.stringify()` of it):

| # | Script | Tests |
| --- | --- | --- |
| 1 | `JSON.stringify({ok:true})` | Pure literal — zero reference to any project code. Does `evalScript()` work AT ALL right now? |
| 2 | `basenameNoExt("/a/b/c.mogrt")` | A bare-global helper function, already exercised indirectly by the confirmed-working `probeSourceTextDeep` — direct invocation, bypassing `dispatch()` entirely. |
| 3 | `echoPayloadDirect("{}")` | A **brand-new**, bare-global (not `$._captionStudioBridge`-scoped) function added purely for this test — see below. |
| 4 | `dispatch("{}")` | A bare, unscoped reference to `dispatch` — `dispatch` only exists as `$._captionStudioBridge.dispatch`, never as a bare global, so this is *expected* to fail (a `ReferenceError`) — confirms the registration model is understood correctly. |
| 5 | `$._captionStudioBridge.dispatch("{\"command\":\"ping\",...}")` | The correctly-scoped call, hand-escaped rather than built by `runExtendScriptCommand()`'s JS, targeting the known-working `"ping"`. |
| 6 | `$._captionStudioBridge.dispatch("{\"command\":\"echoPayload\",...}")` | Same hand-escaped construction, targeting the known-failing `"echoPayload"`. |

`echoPayloadDirect(payloadString)` (`cep-bridge/jsx/hostscript.jsx`) is a
bare top-level `function` declaration — deliberately **not** a
`$._captionStudioBridge` property, and deliberately named differently
from the existing namespaced `$._captionStudioBridge.echoPayload` (same
file, ~20 lines away) to avoid any ambiguity about which one a given call
is exercising. It takes one string, returns a JSON string directly (since
calling it bypasses `dispatch()`'s own `JSON.stringify()`), and calls
nothing else — no Premiere APIs, no other helpers.

### Task 5: confirmed — ScriptPath, not `evalFile()`

`cep-bridge/CSXS/manifest.xml` line 38: `<ScriptPath>./jsx/hostscript.jsx</ScriptPath>`.
`client/main.js` contains no `$.evalFile()` call anywhere — the file is
loaded purely via the manifest's `ScriptPath` mechanism, confirmed by
direct inspection, not inference. "If ScriptPath only loads one
namespace/entry function" — tests #2 and #3 above answer this directly:
if a bare-global function (not part of `$._captionStudioBridge`) is
reachable, `ScriptPath` loads the whole file's top-level scope, not just
one namespace.

### What this round deliberately does NOT do

Per the user's explicit instruction, no new hypothesis-driven diagnostics
were added — no new string/JSON logic, no new stage-tracking, no new
`.mogrt`/Source Text code. Every addition this round exists solely to
narrow down *which layer* fails: a literal, a bare function, or the
dispatcher.

### An install-location risk worth checking directly, independent of everything above

`cep-bridge/README.md`'s setup instructions have the extension loaded from
a **separate, fixed OS folder** (`~/Library/Application Support/Adobe/CEP/extensions/`
on macOS, `%APPDATA%\Adobe\CEP\extensions\` on Windows) — either a symlink
(recommended, keeps edits live) or a **plain copy** of this `cep-bridge/`
folder. If the actual installed copy is a plain copy rather than a working
symlink, every `git pull` + `npm run build` in this repo would leave the
**installed** `hostscript.jsx`/`client/main.js` completely unchanged,
regardless of how many commits land here or how many times Premiere is
restarted — this would independently explain "the restart didn't fix it,"
with no ExtendScript-engine mechanism involved at all. This is not
something this agent can verify without host access, but it costs nothing
to rule out: **confirm the extensions-folder copy is a symlink pointing at
this git checkout (not a stale copy) before drawing conclusions from
any of the tests below.** (macOS: `ls -la` the extensions folder and check
for an `->` symlink target. Windows: `dir` shows `<SYMLINKD>` for a real
symlink vs. a plain directory for a copy — `mklink /D` requires
Administrator privileges or Developer Mode, which the original setup
instructions didn't call out explicitly for Windows; a plain
drag-and-drop copy would look identical in Explorer but never update.)

### What this run cannot answer without live-host access

Which of the six bypass tests is the first to return the literal
`"EvalScript error."` string as `rawResult`. That result — combined with
the install-location check above — should be decisive: if test #1 (pure
literal) already fails, `evalScript()` itself is broken for this
panel/session, unrelated to any of this project's code. If #1 succeeds
but #2/#3 (bare-global functions) fail, `ScriptPath` is not making the
file's top-level scope reachable the way documented CEP/ExtendScript
behavior predicts. If #2/#3 succeed but #5 (hand-escaped, correctly-scoped
dispatch calling a known-working command) fails, the issue is specific to
`$._captionStudioBridge.dispatch` itself. If #5 succeeds but #6
(hand-escaped dispatch calling the known-failing `echoPayload`) also
fails, the issue is specific to that one command's registration —
independent of how the call was constructed, which would point back at
the file actually loaded not containing `echoPayload` at all (the
install-location risk above, restated in a directly falsifiable way).

## Part 14: eighth real-host run — a real bug found in the transport itself, not ExtendScript

**Confirmed real-host result that redirects this investigation again:**
all six `/raw-eval` bypass tests reported "finished with errors" —
**including test #1, the pure literal `JSON.stringify({ok:true})` with
zero reference to any project code, ExtendScript engine, or Premiere
API.** Since that specific script cannot fail for any ExtendScript-side
reason (it doesn't touch `$._captionStudioBridge`, `dispatch`, or any
custom function — it's a call to a built-in that every JavaScript engine
has), a uniform failure across all six, including this one, means the bug
was never in ExtendScript execution at all. It was in this investigation's
own `/raw-eval` transport and response classification, added in Part 13.

**The actual bug, found by re-reading Part 13's own code:** the previous
`runRawEvalScript()` (`cep-bridge/client/main.js`) attempted
`JSON.parse()` on every raw callback and recorded `parsedOk`/
`parsedValue`/`parseError` alongside an unconditional `ok: true` — but
most of the bypass scripts deliberately *don't* return JSON at all (a bare
helper function returning a plain string like `"c"`, or `dispatch("{}")`
throwing a `ReferenceError`). The transport layer itself wasn't actually
setting `ok: false` incorrectly — but the accompanying documentation and
UI language conflated "JSON.parse failed" with "this test failed," and
the whole response shape mixed two genuinely different failure modes
(a transport/HTTP-layer problem vs. `resultString === "EvalScript
error."`) into one ambiguous `ok` flag that the caller-side "finished with
errors" log line then reported on. Per the task list this round, the fix
removes JSON parsing from `/raw-eval` entirely and makes the
success/failure classification explicit and narrow.

### The fix

**New: `cep-bridge/client/rawEvalClassify.cjs`** — pure classification
logic, zero browser/CEP dependencies (unlike the rest of `client/main.js`,
which needs `document`/`CSInterface` to even load), so — unlike every
other file in `cep-bridge/`, which can only get static source-text
regression checks — this one gets **real, executable unit tests**
(`test/cepRawEvalClassify.test.js`, task 8's exact five cases:
`'{"ok":true}'`, `'c'`, `'undefined'` (the string), `''`, and
`'EvalScript error.'`, plus near-miss/substring cases and a real JS
`undefined` callback). `.cjs`, not `.js` — this project's `package.json`
sets `"type": "module"`, and a plain `.js` file would be parsed as ESM
under Node's `require()`/`import` resolution regardless of its contents;
`.cjs` forces unambiguous CommonJS so both `client/main.js`'s
`require("./rawEvalClassify.cjs")` (inside the CEP panel) and the test
file's `import` (under plain Node) load the exact same code.

```js
function classifyRawEvalResult(resultString) {
  const rawResultType = typeof resultString;
  const rawResult = resultString === undefined ? null : resultString;
  const rawResultLength = rawResult === null ? 0 : String(rawResult).length;
  const isEvalScriptError = resultString === "EvalScript error.";
  return { ok: !isEvalScriptError, rawResult, rawResultType, rawResultLength, isEvalScriptError };
}
```

`ok` is `false` **only** when `resultString` is exactly the literal
`"EvalScript error."` string — never because it "isn't JSON."

**`cep-bridge/client/main.js`:**
- `runRawEvalScript()` now calls `classifyRawEvalResult()` instead of
  attempting its own `JSON.parse()` (tasks 2/5 — `/raw-eval` treats the
  callback as raw text only).
- Logs the raw callback's `typeof`, length, and `JSON.stringify()` of it
  **before** classification (task 1).
- Every resolution path (success, `isEvalScriptError`, timeout,
  synchronous `evalScript()` throw) now returns the same seven-field
  envelope (task 3): `{ok, script, rawResult, rawResultType,
  rawResultLength, isEvalScriptError, transportError}` — `transportError`
  is `null` on a normal ExtendScript-level response (whether or not it was
  `"EvalScript error."`) and non-null **only** when the transport/CEP
  layer itself failed (timeout, synchronous throw) — task 4's exact two
  conditions for `ok: false`, now split into two distinct, independently
  checkable fields (`isEvalScriptError` vs. `transportError`) rather than
  one overloaded `ok`.
- `handleRawEval()` now logs the exact received request body and the
  extracted `script` field **unconditionally, on every call** (task 9) —
  directly answering "is the route actually receiving the requested
  script" without guessing.

**`src/ppro/cepBridge.js`'s `runRawEvalScript()`** (UXP side): updated to
the same seven-field shape; every one of its own failure branches
(health-check failure, non-2xx HTTP response, fetch exception/timeout)
now sets `transportError` (never a generic `error`/`step` field, and
never conflated with `isEvalScriptError`) — and, per task 6, it still
does **not** route through `callCepBridge()` (the `/command`
dispatch-command parser every other command uses) — `/raw-eval` remains
its own, separate HTTP call with its own response shape.

**`src/ui/cepBridgePanel.js`'s `bypassResultBlock()`** (task 7): now shows
`rawResult` (via `JSON.stringify()`, so hidden characters are visible),
`rawResultType`, `rawResultLength`, `isEvalScriptError`, and — kept
visually distinct from all of the above — `transportError` when present.

### Verification

- `test/cepRawEvalClassify.test.js` (8 tests, real execution): task 8's
  exact five success/failure cases, plus near-miss substrings and the
  real-`undefined` edge case.
- `test/cepClientMain.test.js` (new, static source-text regression checks,
  same reasoning as `test/cepHostScript.test.js`): confirms
  `runRawEvalScript()` never calls `JSON.parse()` on the raw callback,
  logs `typeof`/length/`JSON.stringify()` before classifying, that the
  transport-failure envelope always includes all seven fields, that `ok`
  is never derived from JSON-parseability anywhere in the raw-eval path,
  and that `/command`'s own (unrelated, unchanged) JSON body-parsing is
  still intact.
- `test/cepBridge.test.js`: `runRawEvalScript()`'s UXP-side client
  function updated/extended for the new shape, including a case
  forwarding a bare non-JSON string (`"c"`) as a genuine success.

### What this run cannot answer without live-host access

Whether this actually fixes what the user sees, and — now that the
transport layer reports real, unambiguous ExtendScript-level results —
which of the six bypass tests' `isEvalScriptError` is actually `true`.
That result is what will finally answer Part 13's still-open question
(pure literal vs. bare-global helper vs. bare-global new function vs.
bare unscoped `dispatch` vs. qualified `dispatch` for a known-working vs.
known-failing command) — this round's fix was necessary but was, by
itself, about the measurement tool, not the thing being measured.
