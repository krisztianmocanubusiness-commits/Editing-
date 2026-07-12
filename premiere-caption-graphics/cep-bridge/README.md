# Caption Studio CEP Bridge (experimental)

A proof-of-concept CEP extension, separate from the main UXP panel one
directory up. Read `docs/CEP_BRIDGE_INVESTIGATION.md` first — this exists to
answer one question (can `ComponentParam.setValue()` write MOGRT Source Text
where UXP's `createSetValueAction()` couldn't), grounded in Adobe's own
ExtendScript reference docs, not guesses.

## What it does

1. Runs a small local HTTP server (`http://127.0.0.1:3010`) inside a CEP
   panel, using CEP's Node.js integration.
2. The main UXP panel's new "CEP Bridge (experimental)" section
   (`src/ui/cepBridgePanel.js`) sends it one command:
   `createTextGraphic` — import the configured `.mogrt` at the playhead, set
   its duration to 2s, locate its `Source Text` param, and attempt to write
   `__KERIS_CEP_TEST__` to it via ExtendScript's `ComponentParam.setValue()`.
3. Returns a structured JSON result (success/failure at every step) back to
   the UXP panel, which logs and displays it exactly like every other
   diagnostic in this project.

**This does not clean up after itself.** Unlike the UXP diagnostics (which
always delete their temporary clip), this proof of concept deliberately
leaves the created clip on the timeline so you can look at it. Delete it by
hand once you're done testing.

## Setup (one-time, per machine)

CEP extensions load from a fixed OS folder, and Premiere Pro refuses to load
an **unsigned** extension (like this one, in development) unless a debug
flag is enabled first.

### 1. Enable unsigned/debug CEP extensions

- **macOS**: in Terminal:
  ```
  defaults write com.adobe.CSXS.9 PlayerDebugMode 1
  defaults write com.adobe.CSXS.10 PlayerDebugMode 1
  defaults write com.adobe.CSXS.11 PlayerDebugMode 1
  ```
  (Repeat for whichever `CSXS.N` matches your Premiere Pro version if the
  ones above don't apply — Premiere Pro 26.x uses a CSXS major version in
  the 9-11 range; if the panel doesn't appear after install, try the
  adjacent numbers too.)
- **Windows**: in `regedit`, under
  `HKEY_CURRENT_USER\Software\Adobe\CSXS.9` (and `.10`, `.11`), add a String
  value named `PlayerDebugMode` set to `1`. Create the `CSXS.N` key if it
  doesn't exist.

### 2. Install the extension

CEP loads extensions from a fixed per-user folder. Copy (or symlink) this
entire `cep-bridge/` folder into it, keeping the folder name:

- **macOS**: `~/Library/Application Support/Adobe/CEP/extensions/`
- **Windows**: `%APPDATA%\Adobe\CEP\extensions\`

So you end up with, e.g. on macOS:
`~/Library/Application Support/Adobe/CEP/extensions/cep-bridge/CSXS/manifest.xml`

A symlink is recommended over a copy so edits here take effect without
re-copying:

```bash
# macOS example
ln -s "$(pwd)/cep-bridge" ~/Library/Application\ Support/Adobe/CEP/extensions/cep-bridge
```

### 3. Load it in Premiere Pro

Restart Premiere Pro (or just open it if it wasn't running), then:
`Window` → `Extensions` → `Caption Studio CEP Bridge (experimental)`.

You should see a small panel with a status line. It should read
`Listening on http://127.0.0.1:3010 — keep this panel open…` within a
second or two. **Keep this CEP panel open** — the moment it's closed, its
Node HTTP server stops, and the UXP panel's CEP Bridge button will report
"CEP bridge unavailable."

If the status line instead shows an error, check the DevTools console
first (see below) before anything else.

## Testing / debugging the CEP panel itself

With the `.debug` file in this folder, Premiere Pro exposes a Chrome
DevTools remote debugger for this panel on port `7778`. With the panel open
in Premiere, visit `http://localhost:7778` in a Chromium-based browser (or
`about:inspect` in Chrome) to get a full console/network inspector for
`main.js` — this is the fastest way to see exactly what's happening inside
the bridge (every request/response is also logged to this console, not just
the on-panel log box).

## Running the proof of concept

1. Open a Premiere Pro project with an active sequence, and have a `.mogrt`
   path ready (the same one already used elsewhere in this project's UXP
   panel — see the main panel's Template Inspector section).
2. Open the CEP Bridge panel (step 3 above) and confirm it shows
   "Listening…".
3. In the main UXP panel, go to the new "CEP Bridge (experimental)"
   section, choose the same `.mogrt`, and click "Test CEP Write (POC)".
4. Watch the main panel's Log — it reports the full structured result:
   whether the clip was created, whether the duration was set, whether
   `Source Text` was found, and — the key question — whether
   `setValue("__KERIS_CEP_TEST__", true)` succeeded or threw, with the
   exact host error either way.
5. Check the Premiere Pro timeline directly too — if the write reports
   success, look at the clip's Essential Graphics panel to visually confirm
   the text actually changed (the same "API says success but is it actually
   visible" caveat applies here as it did for every UXP write attempt).

## Uninstalling

Remove (or unlink) the `cep-bridge` folder from the CEP extensions
directory listed in step 2, and quit the CEP Bridge panel if it's open.
This does not affect the main UXP extension at all.
