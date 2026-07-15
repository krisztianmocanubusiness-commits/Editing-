# Installing an older Premiere Pro release alongside 26.3, to test `testLegacySourceTextSetValue`

This is the setup guide for
`docs/CAPTION_GRAPHICS_ARCHITECTURE_DECISION.md`'s smallest remaining
proof of concept: the CEP bridge's new `testLegacySourceTextSetValue`
command, which can only run on a Premiere Pro version where
`CSInterface.evalScript()` actually works (confirmed broken on this
project's current 26.3 host — `docs/CEP_BRIDGE_INVESTIGATION.md` Part 17).

## Which version to install first, and why

**Recommended: Premiere Pro 24.0** (the initial 2024 major release).

Reasoning, grounded in this project's own prior findings:

1. **It predates Adobe's CEP sunset clock by well over a year.**
   `docs/CEP_BRIDGE_INVESTIGATION.md` Part 1 quotes Adobe's own posted
   timeline: the one-year CEP-removal countdown started at **Premiere Pro
   25.6**, and ExtendScript itself is separately guaranteed only "through
   September 2026." 24.0 sits comfortably before either boundary — it's
   from before Adobe began actively winding this down, which is the
   opposite end of the version range from the confirmed-broken 26.3.
2. **It satisfies this extension's own compatibility floor.**
   `cep-bridge/CSXS/manifest.xml` already declares `<Host Name="PPRO"
   Version="[22.0,99.0]" />` and `<RequiredRuntime Name="CSXS"
   Version="9.0" />` — 24.0 is well within the declared host range, and
   its bundled CEP runtime is expected to satisfy CSXS 9.0 (the same
   runtime family this project's manifest already targets at its floor,
   22.0).
3. **It's recent enough that Essential Graphics/MOGRT internals are
   unlikely to differ in a way that confounds the test.** The whole point
   of this experiment is to isolate whether `ComponentParam.setValue()`'s
   legacy two-argument calling convention behaves differently from UXP's
   `createSetValueAction()` (Part 2's prediction) — not to introduce a
   second, unrelated variable by picking a version so old that Source
   Text's internal representation might itself have changed.

If Creative Cloud doesn't offer an exact 24.0 build, the next-best choice
is the closest available 24.x point release, then the newest available
23.x — anything at or above the manifest's declared floor (22.0) is
usable; anything from *after* 25.6 defeats the point of this experiment
and shouldn't be used for it.

## Step 1: install the older version via Creative Cloud desktop, side-by-side with 26.3

Adobe supports installing multiple Premiere Pro major versions on the same
machine at once — installing an older version does **not** replace or
require uninstalling 26.3.

1. Open the **Creative Cloud desktop app**.
2. Go to the **Apps** tab and find **Premiere Pro** in your installed/available
   apps list.
3. Click the **down-arrow / "…" (other actions) menu** next to Premiere
   Pro's Open/Install button.
4. Choose **"Other Versions"** (sometimes labeled "View previous
   versions" or similar, depending on the current Creative Cloud desktop
   UI).
5. From the version list, select **24.0** (or the closest available
   release per the recommendation above).
6. Click **Install**. Creative Cloud installs it to its own
   version-specific folder (e.g. `Adobe Premiere Pro 2024` alongside
   `Adobe Premiere Pro 2026` on the same machine) — it will not overwrite
   or remove Premiere Pro 26.3.
7. Once installed, launch the older version specifically from Creative
   Cloud desktop's version list (not just the default "Open" button, which
   launches the newest installed version) — or find it directly by its own
   name in your Start Menu / Applications folder (Windows installs each
   version with a year-qualified name, e.g. "Adobe Premiere Pro 2024";
   macOS similarly keeps each version as a separate `.app`).

## Step 2: no separate extension install needed — the same `cep-bridge/` folder is already shared

CEP loads extensions from one fixed **per-user, per-OS** folder — not a
per-Premiere-version folder:

- **macOS**: `~/Library/Application Support/Adobe/CEP/extensions/`
- **Windows**: `%APPDATA%\Adobe\CEP\extensions\`

If you already followed `cep-bridge/README.md`'s setup for the 26.3 host
(symlinking or copying `cep-bridge/` into that folder), the older Premiere
Pro 24.0 install will find the **exact same** extension automatically —
nothing to reinstall or duplicate. If you haven't set it up yet, follow
`cep-bridge/README.md`'s "Setup (one-time, per machine)" section once; it
covers both versions simultaneously.

## Step 3: enable unsigned/debug mode for the older version's CEP runtime, if needed

`cep-bridge/README.md` already documents enabling `PlayerDebugMode` for
`CSXS.9`/`CSXS.10`/`CSXS.11`. Those same registry keys (Windows) /
`defaults write` commands (macOS) apply regardless of which Premiere
version is running, since `PlayerDebugMode` is keyed by **CSXS runtime
version**, not by Premiere Pro version — if you've already done this step
for the 26.3 host, no further action is needed for 24.0 (they very likely
share the same CSXS 9-11 range). If the panel doesn't appear under
**Window > Extensions** in the older Premiere version, re-run
`cep-bridge/README.md`'s step 1 to confirm the flag is set for whichever
`CSXS.N` that specific build actually uses (check Premiere's own
Help/About or the extension's own startup log — if the panel loads at all,
its `#status` line and log confirm the flag is already correct).

## Step 4: run the test

1. Launch Premiere Pro 24.0 (or whichever older version you installed).
2. Open (or create) a project with an active sequence — `testLegacySourceTextSetValue`
   requires `app.project.activeSequence` to exist, same as every other
   command in this bridge.
3. Open **Window > Extensions > Caption Studio CEP Bridge (experimental)**.
4. Wait for the status line to read **"Listening on http://127.0.0.1:3010
   — hostscript.jsx build: 2026-07-15-legacy-setvalue-r1"** — this confirms
   `evalScript()` works on this host at all (if it's stuck on "Starting…"
   or shows a startup error, `evalScript()` is broken here too, and this
   version isn't a usable test host — try the next-oldest available
   version).
5. In the **"Full path to 'Keris Master Caption.mogrt'"** field, paste the
   full, absolute path to that `.mogrt` file on disk (e.g.
   `C:\Users\you\Documents\Keris Master Caption.mogrt` on Windows, or
   `/Users/you/Documents/Keris Master Caption.mogrt` on macOS).
6. Click **"Run testLegacySourceTextSetValue"**.
7. Wait for the result — it appears in the panel's result box below the
   button as formatted JSON, and a one-line summary is logged to the
   scrolling log underneath.

## Expected pass/fail output

The response is `{ ok, requestId, result, stages }`. `stages` is an
ordered array — one entry per step (`app-name`, `open-active-sequence`,
`get-playhead-position`, `import-mogrt`, `identify-track-item`,
`locate-text-component`, `locate-source-text-property`,
`get-value-before`, `set-value`, `get-value-after`) — each with its own
`ok` flag, so a failure at any stage still shows every stage that
succeeded before it.

- **Overall `ok: true`** means `sourceTextParam.setValue("__KERIS_LEGACY_TEST__",
  true)` did not throw. `result.setValueSucceeded` is `true`,
  `result.valueAfterWrite` shows what `getValue()` returned immediately
  afterward, and `result.valueBeforeWrite` shows what it was beforehand —
  compare the two to see whether the underlying value actually changed
  (a non-throwing `setValue()` call and an actually-changed value are two
  different things worth checking independently; this response gives you
  both).
- **Overall `ok: false`** with the `set-value` stage's `ok: false` and an
  `error` field means `setValue()` threw — the field is the exact
  exception message (e.g. an `Illegal Parameter type`-style rejection
  would land here, the same class of error UXP's `createSetValueAction()`
  hit). This is the single most informative possible failure: it means
  `evalScript()` and the whole identification path worked, and the
  legacy calling convention was rejected for the same underlying reason
  UXP's was.
- **Overall `ok: false`** with an earlier stage's `ok: false` (e.g.
  `import-mogrt` or `locate-text-component`) means the test didn't even
  reach `setValue()` — something about this specific host, project, or
  `.mogrt` file blocked an earlier step; the `error` field on that stage
  explains what.

## How to visually verify the text actually changed

The clip is **deliberately left on the timeline** (`result.clipLeftOnTimeline:
true` — no removal call anywhere in `testLegacySourceTextSetValue`, per
this round's explicit instruction), so you can check it directly in
Premiere itself, independent of what the JSON response says:

1. In Premiere's timeline, find the newly inserted clip (it was placed at
   your playhead position, on the topmost video track).
2. Either:
   - Move the playhead over the clip and look at the **Program Monitor** —
     if the write succeeded, the on-screen text should now read
     `__KERIS_LEGACY_TEST__` instead of the MOGRT's original default text; or
   - Select the clip and open the **Essential Graphics panel** (Window >
     Essential Graphics) — its **Edit** tab lists the template's editable
     text field(s); if the write succeeded, the field's displayed value
     should show `__KERIS_LEGACY_TEST__` there too.
3. If the Program Monitor / Essential Graphics panel still shows the
   original default text even though the JSON response reported
   `ok: true` and `setValueSucceeded: true`, that itself is a meaningful,
   reportable result: it means `setValue()` didn't throw but also didn't
   actually change what Premiere renders/considers the value — a
   "silently accepted but ineffective write," distinct from both a clean
   success and a thrown rejection. Compare `result.valueBeforeWrite` and
   `result.valueAfterWrite` from the JSON response against what's
   visually on screen to tell these cases apart.
