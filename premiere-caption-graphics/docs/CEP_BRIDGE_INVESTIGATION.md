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
