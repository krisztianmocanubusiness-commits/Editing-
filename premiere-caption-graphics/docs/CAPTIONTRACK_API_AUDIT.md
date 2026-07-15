# CaptionTrack / UXP capability audit (Premiere Pro 26.3)

## Method and source

This audit is grounded in the **actual shipped TypeScript declaration file**
for the UXP Premiere Pro API, not a documentation page — `npm pack
@adobe/premierepro@26.3.0` (the exact version matching this project's
target host) and a direct read of `src/premierepro.d.ts` (4,675 lines).
This is the same file Adobe publishes for editor autocomplete/typechecking
against the real, live UXP surface — it is the literal type contract the
`premierepro` module implements, not prose that can drift from behavior.

`@adobe/premierepro`'s own `package.json` description: *"The TypeScript
definitions and declarations for UXP APIs in Premiere."* Published by
Adobe (`@adobe` npm scope), sourced from `github.com/adobe/premierepro-types`.

For cross-check, the same file was also pulled for the newest available
prerelease, `26.5.0-beta.61` (ahead of 26.3.0) — the caption-related surface
is **functionally unchanged** between the two (the only diff is a return-type
annotation fix on `createSetNameAction`, `object` → `Action`; see "Currency
of this finding" below).

Two official documentation pages were also identified via search
(`developer.adobe.com/premiere-pro/uxp/ppro_reference/classes/captiontrack/`
and the community thread
`community.adobe.com/.../issue-accessing-caption-items-via-captiontrack-api...`),
but this session's outbound network policy blocks `developer.adobe.com`,
`*.docsforadobe.dev`, and `community.adobe.com` directly (confirmed via the
proxy's own status endpoint — `gateway answered 403 to CONNECT (policy
denial)` for each host). Search-result summaries of those pages are used
only as **corroborating**, secondary evidence below, explicitly marked as
such; every primary claim in this document is verified against the actual
`.d.ts` file, not the blocked pages.

## Task 1–3: full method inventory, by class, classified

Classification key: **W** = officially documented and writable/creatable,
**R** = readable only, **A** = absent from the public API entirely.

### `CaptionTrack` (and `CaptionTrackStatic`)

```ts
export declare type CaptionTrackStatic = {};

export declare type CaptionTrack = {
  createSetNameAction(name: string): object;   // → Action in 26.5.0-beta
  setMute(mute: boolean): Promise<boolean>;
  getMediaType(): Promise<Guid>;
  getIndex(): Promise<number>;
  isMuted(): Promise<boolean>;
  getTrackItems(trackItemType: number, includeEmptyTrackItems: boolean): [];
  readonly name: string;
  readonly id: number;
};
```

This is the **entire** `CaptionTrack` surface. Note `CaptionTrackStatic =
{}` — completely empty. There is no static factory method anywhere (no
`CaptionTrack.create(...)`, nothing comparable to `Project.createProject()`
or `AudioTrack`'s equivalents).

| Capability | Status | Evidence |
|---|---|---|
| Rename a caption track | **W** | `createSetNameAction(name)` — the *only* write method on the whole class |
| Mute/unmute a caption track | **W** | `setMute(mute)` |
| Read track's media type, index, mute state, name, id | **R** | `getMediaType`, `getIndex`, `isMuted`, `.name`, `.id` |
| Enumerate a caption track's items | **R**, and only loosely — `getTrackItems()` returns an untyped `[]`, not a typed array of a dedicated caption-item class | `getTrackItems(trackItemType, includeEmptyTrackItems): []` |
| **Create a caption track** | **A** | No method exists on `CaptionTrack`, `CaptionTrackStatic`, `Sequence`, or `SequenceEditor` (see below) |

### Caption track-item class

**A — absent entirely.** There is no `CaptionTrackItem`, `Caption`, or any
other caption-specific item class anywhere in the 4,675-line declaration
file. The only track-item classes that exist at all are
`VideoClipTrackItem` and `AudioClipTrackItem` — there is no third,
caption-flavored sibling. `CaptionTrack.getTrackItems()`'s return type
(`[]`, i.e. an untyped empty-tuple array) is consistent with this: there is
no class for its elements to be typed as. Whatever object shape a live
caption item actually has at runtime is **undocumented** in the public
TypeScript surface — this audit cannot confirm even read access to
per-item caption text through any documented, typed method.

### `Sequence`

The only caption-related members on `Sequence`:

```ts
getCaptionTrackCount(): Promise<number>;                    // R
getCaptionTrack(trackIndex: number): Promise<CaptionTrack>;  // R
```

Both are **read-only enumeration** — get a count, get a track by index.
**There is no `createCaptionTrack`, `addCaptionTrack`, or any caption-track
creation method on `Sequence` in the current UXP API.**

This directly contradicts a plausible-sounding but **wrong-API** result a
search engine surfaces for "Premiere createCaptionTrack": a method by that
exact name —
`app.project.sequences[index].createCaptionTrack(projectItem, startAtTime,
[captionFormat])`, with a `Sequence.CAPTION_FORMAT_708` constant — **does**
exist, but only in the **legacy ExtendScript** API
(`ppro-scripting.docsforadobe.dev`), not in UXP's `premierepro` module.
The `.d.ts` file audited here is the UXP surface specifically, and it has
no equivalent. Even taken at face value, that ExtendScript method only
generates a caption track from an **already-transcribed `ProjectItem`**
(one with an embedded transcript/caption dataset) — it is not a
manual/individual caption-item authoring API, and per
`docs/CEP_BRIDGE_INVESTIGATION.md` Part 17, ExtendScript execution itself
is now confirmed broken on this project's live host regardless.

### `SequenceEditor`

Full inventory of creation-relevant methods: `createRemoveItemsAction`,
`createInsertProjectItemAction`, `createOverwriteItemAction`,
`createCloneTrackItemAction`, `insertMogrtFromPath`,
`insertMogrtFromLibrary`. **None reference captions.** The only
graphics-creation path here is MOGRT insertion — the same mechanism this
project already uses and already knows cannot have its `Source Text`
written (`docs/MOGRT_DIAGNOSTIC.md`).

### `ComponentParam`

Unchanged from what this project's own prior investigation already found
and already exhausted — reproduced here only to confirm the *current*
26.3.0 signature matches exactly:

```ts
createKeyframe(inValue: number | string | boolean | PointF | Color): Keyframe;
createSetValueAction(inKeyFrame: Keyframe, inSafeForPlayback?: boolean): Action;  // the tested, rejected write path
getStartValue(): Promise<Keyframe>;
// ...keyframe/time-varying methods
```

`createSetValueAction()` — the UXP write path already tested exhaustively
in `docs/MOGRT_DIAGNOSTIC.md` and rejected with `Illegal Parameter type`
for `Source Text` — is confirmed present, unchanged, in the exact version
this project targets. No new write method was added here. **Classification
unchanged from prior investigation: W (documented, writable) for the API
call itself, but empirically rejected for this specific param.**

### `Project`

Project-level creation methods (`createProject`, `open`, bin/import
methods) exist but none are graphics/title/caption-specific — omitted here
as out of scope; nothing found changes any prior finding.

### `Transcript` / `TextSegments`

```ts
export declare type TranscriptStatic = {
  importFromJSON(jsonString: string): TextSegments;
  createImportTextSegmentsAction(textSegments: TextSegments, clipProjectItem: ClipProjectItem): Action;
  querySupportedLanguages(): Array<{ displayString: string; languageCode: string; locale: string }>;
  hasTranscript(clipProjectItem: ClipProjectItem): boolean;
  exportToJSON(clipProjectItem: ClipProjectItem): Promise<string>;
};
export declare type Transcript = {};
export declare type TextSegments = {};
```

| Capability | Status | Evidence |
|---|---|---|
| Attach a transcript (as opaque `TextSegments`) to a `ClipProjectItem` | **W** | `createImportTextSegmentsAction(textSegments, clipProjectItem)` |
| Check/export a clip's existing transcript | **R** | `hasTranscript`, `exportToJSON` |
| Convert an attached transcript into a caption track, or a caption track into an editable graphic | **A** | No method anywhere bridges `Transcript`/`TextSegments` to `CaptionTrack`, `SequenceEditor`, or any graphics-creation call |

This is a real, documented, writable API — but it only writes transcript
*metadata* onto a bin item (the data Premiere's own UI uses for its
Text-Based Editing panel and auto-caption generation feature). There is no
UXP method that takes that attached transcript and produces a caption
track, caption items, or any timeline object — that step, in the UXP API
as shipped today, requires the Premiere UI itself.

### `SequenceEditor` / no title, graphic, or style class

A full scan of every top-level exported type in the file for anything
graphics/title/style-related found **zero** matches for `Title`,
`Graphic`, `Style`, `Font`, `Shadow`, `Background`, `Align`, or `Animat*`
as class/type names. **There is no dedicated styling class in the public
UXP API at all** — not for captions, not for anything else. Every styling
capability this project has ever accessed goes through generic MOGRT
`ComponentParam`s (font size, fill color, position — already implemented
in `src/ppro/*.js`), which is a completely separate mechanism from
`CaptionTrack`.

## Task 2: the exact yes/no checklist

| Can UXP… | Answer | Why |
|---|---|---|
| create a caption track | **No** | `CaptionTrackStatic = {}`; `Sequence` has no `createCaptionTrack` |
| create individual caption items | **No** | No caption-item class exists at all; no creation method anywhere |
| set caption text | **No** | No method — there's no item class to hold text |
| set caption start/end times | **No** | Same reason |
| set font, size, fill, background, shadow, or alignment | **No** | No caption styling class exists in the public API, period |
| style different words within one caption | **No** | No per-word/range styling API for captions exists |
| convert captions into editable graphics | **No** | No conversion method anywhere; `Transcript`'s import path stops at attaching metadata to a bin item |
| animate captions or their words | **No** | No animation API for captions exists |

**Every row is No.** `CaptionTrack`'s only two write methods
(`createSetNameAction`, `setMute`) operate on the *track itself*, not on
caption content.

## Corroborating (secondary, non-primary) evidence

A search-result summary of the official `CaptionTrack` documentation page
(not independently fetchable this session — see "Method and source"
above) states directly: *"The Caption API is still under construction, and
there is no available API to access and modify caption properties yet."*
A community thread title, *"Issue Accessing Caption Items via CaptionTrack
API in Premiere Pro UXP Scripting,"* is consistent with third-party
developers independently hitting the same wall documented here first-hand
against the `.d.ts` file. Both are cited only as corroboration; the
primary finding stands on the `.d.ts` inventory above regardless.

## Currency of this finding

Cross-checked against `@adobe/premierepro@26.5.0-beta.61` (the newest
available prerelease, ahead of the 26.3.0 this project targets): the
`CaptionTrack` surface is **identical in capability** — the only textual
diff is `createSetNameAction`'s return-type annotation (`object` →
`Action`), a typing correction with no capability change. As of the most
current Adobe-published beta available, the caption API has not
progressed since 26.3.0.

## Tasks 4–5: proof of concept

**Not built.** Per this round's explicit instruction, no proof of concept
is fabricated where no documented creation/write path exists. There is no
`CaptionTrack` write method to prove — building a "proof" here would mean
demonstrating `createSetNameAction()`/`setMute()` (real, but irrelevant to
the product requirement) or silently falling back to some other mechanism
and mislabeling it a CaptionTrack proof. Neither is honest. This audit's
conclusion is definitive enough, from the shipped type declarations alone,
that no live-host run is needed to reach it: the methods required simply
do not exist in the file Adobe publishes for this exact API version.
