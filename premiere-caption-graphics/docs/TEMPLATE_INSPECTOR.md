# Template Inspector

The Template Inspector (panel section **"1. Template Inspector"**) is the
editor workflow that sits between "the host smoke test passes" and "I can
actually apply captions": pick a `.mogrt`, find out exactly how it relates
to the `KERIS_CAPTION_V1` contract, and — if you're happy with it — save it
as the one the rest of the panel uses by default. Nothing here touches
transcript, chunking, or keyword logic; it's purely about choosing and
validating the template your captions will be built from.

## Prerequisites

- The panel's **"0. Host smoke test"** should already report at least a
  working insert/trim path (see `docs/PREMIERE_HOST_TEST.md`) — the
  Template Inspector uses the exact same `insertMogrtFromPath` /
  component-chain-read mechanism, just wrapped for a different purpose.
- A project with an active, focused sequence containing at least one video
  track (same preconditions as the smoke test).
- One or more `.mogrt` files you're considering using. They don't need to
  be contract-compliant to inspect — that's the point of inspecting them.

## Workflow

### 1. Choose a `.mogrt` to inspect

Click **"Choose .mogrt to inspect…"** and pick a file. This does not touch
the timeline yet — it just records the path.

### 2. Inspect it

Click **"Inspect Template"**. Under the hood
(`src/ppro/templateInspector.js`):

1. Inserts the `.mogrt` on the active sequence's topmost video track, at
   the start of the current selected range (or 0 if none is set) — a
   **temporary** clip, purely for reading.
2. Reads its full component/param chain (the same detailed dump the smoke
   test produces — component names, param names, best-effort types,
   current values — all logged).
3. Removes the temporary clip again (`removeTrackItem` in
   `src/ppro/mogrt.js`, the same `SequenceEditor.createRemoveItemsAction`
   pattern Adobe's own sample uses for track-item removal). If cleanup
   itself fails for some reason, that's logged as a warning with an
   explicit "you may need to delete it by hand" note — inspection results
   are still returned either way.
4. Compares the discovered param names against `KERIS_CAPTION_V1` and
   against every contract in the registry (currently just the one).

You'll see, both in the results block on the panel and in the log:

- **COMPLIANT / NOT COMPLIANT** with `KERIS_CAPTION_V1`.
- **Missing required params** — the exact display names (see
  `mogrt-contracts/KERIS_CAPTION_V1.md`) this template doesn't expose, if
  any. This is a strict, exact-name comparison — no aliasing, no guessing.
- **Extra params** — exposed params this template has that aren't part of
  the `KERIS_CAPTION_V1` required list. Not an error, just informational
  (a template is free to expose more than one contract needs).
- **Detected contract** — which registered contract (if any) this
  template's exposed params satisfy exactly. With only one contract
  shipped so far this will only ever say `KERIS_CAPTION_V1` or "none
  matched exactly"; the detection logic (`detectContract()` in
  `src/presets/contractValidation.js`) already supports multiple
  contracts for when more get added.

### 3. Save as active template

Click **"Save as active template"** (enabled once an inspection has
completed, compliant or not). This stores the `.mogrt` path and its
detected/target contract ID via `src/state/settings.js`, and the panel
immediately shows it under **"Active template: ..."**.

- Saving a **NOT COMPLIANT** template is allowed (you might be
  iterating on a template and want to keep testing it), but the panel logs
  a loud warning explaining that timeline apply will still try to use it,
  and any missing required param just won't get set on the timeline (the
  apply step already reports missing params per chunk — see
  `docs/PREMIERE_HOST_TEST.md`'s discussion of `applyCaptions.js`'s
  best-effort behavior).
- Saving does **not** require re-running Inspect first if you already have
  a result for the currently-chosen path — but if you switch the chosen
  `.mogrt` without re-inspecting, "Save as active template" stays disabled
  until you do (it always saves the *last inspection result*, never an
  unverified path).

## Where "active template" is stored

`src/state/settings.js` persists `{ path, contractId, compliant, savedAt }`
to the panel webview's `localStorage`, so it survives closing and reopening
the panel. **This has not been confirmed against a live UXP panel** — if
your installed UXP host version doesn't expose `localStorage` to panels,
the module catches that and falls back to an in-memory value that lasts
for the current panel session only, logging a warning when you save so
you know persistence didn't actually happen. Either way, the active
template is immediately usable within the current session regardless of
whether it persisted.

## How the timeline apply step uses it

Section **"6. Approve & apply"** resolves, for each apply click, an
*effective* template via `withActiveTemplateFallback()` in
`src/presets/effectiveMogrt.js`:

1. If the currently selected **preset** already has its own `mogrt.path`
   set (via "5. Style preset" → "Choose .mogrt…"), that wins — unchanged
   from before the Template Inspector existed.
2. Otherwise, it falls back to the saved **active template**.

The apply panel shows which one it'll use ("Will use: ...") before you
click Apply, and updates live as you change presets or the active
template.

## If no active template is saved

If neither the active preset nor the saved active template has a `.mogrt`
path, the **Apply** button is disabled and the panel shows, in place of
the "Will use: ..." line:

> No .mogrt to apply: this preset has no template of its own, and no
> active template is saved. Open "1. Template Inspector" above, inspect a
> compliant .mogrt, and click "Save as active template" — or choose a
> .mogrt directly on this preset in "5. Style preset" → "Choose .mogrt…".

This is a hard block, not just a warning — `apply()` in
`src/ui/applyPanel.js` returns before doing anything if there's no
resolvable template, so there's no way to trigger a timeline write with a
missing template path.

## Diagnostic Inspector ("2. Diagnostic Inspector")

A separate, more verbose read-only mode for the case where a template's
discovered params don't look like editable graphic/text controls at all
(e.g. only `Motion`/`Opacity`/`Crop`-style names) and you need to know
whether that's because the template genuinely has nothing exposed, or
because `getComponentChain()` isn't surfacing its real controls. Click
**"Run Diagnostic Inspector"** to get every component's display name *and*
best-effort match name, classified as `intrinsic` (Motion/Opacity/Crop/Time
Remapping), `graphic-or-mogrt`, or `effect-or-unknown`, with every param's
name/type/current value — logged in full and saveable as JSON via **"Save
diagnostic JSON…"**. See `docs/MOGRT_DIAGNOSTIC.md` for why this exists,
what was and wasn't confirmed about Premiere's UXP API surface for MOGRTs,
and how to read the output.

## What this does not do (yet)

- It does not require the active template to be `KERIS_CAPTION_V1`-
  compliant before letting you save or apply it — it tells you clearly
  when it isn't, but doesn't stop you.
- It does not support per-chunk template overrides (e.g. one template for
  a "keyword" chunk and a different one for a plain subtitle chunk) — one
  active template (or one preset-level template) applies to a whole apply
  run. Per-chunk preset/template assignment would be a real product
  feature beyond this task's scope.
- It does not add or change anything in `src/caption/`, `src/transcript/`,
  or the keyword-detection logic — this is entirely about template
  selection and validation.
