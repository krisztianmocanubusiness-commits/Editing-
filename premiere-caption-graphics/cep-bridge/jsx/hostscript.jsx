/**
 * ExtendScript host script — runs inside Premiere Pro itself (not the CEP
 * panel's browser context), invoked via CSInterface.evalScript() from
 * client/main.js. Every API used below is grounded in the official,
 * current Premiere Pro ExtendScript reference
 * (docsforadobe/premiere-scripting-guide) — see
 * docs/CEP_BRIDGE_INVESTIGATION.md Part 3 for the full table of sources.
 *
 * Deliberately does NOT clean up the clip it creates — unlike every UXP
 * diagnostic in ../../src/ppro/, which always removes its temporary
 * inspection clip. This IS the proof of concept the task asked for: the
 * created clip is meant to be visually inspected on the timeline
 * afterward, not auto-deleted. Delete it by hand once you're done.
 */

if (typeof $._captionStudioBridge === "undefined") {
  $._captionStudioBridge = {};
}

// Real-host finding that demands this (see docs/CEP_BRIDGE_INVESTIGATION.md
// Part 12): bisectHostScript()'s step 0 — a bare minimal return, no
// string/JSON helpers, no Premiere APIs — failed with the same non-JSON
// "EvalScript error." as every command added since probeSourceTextDeep
// (still confirmed working). Since the failure is that immediate and that
// context-free, and since a full brace-balance + top-level-scope audit of
// this file found nothing structurally wrong, the leading suspect is
// Adobe's own documented CEP/ExtendScript behavior: the manifest's
// ScriptPath file is evaluated ONCE into a persistent ExtendScript engine
// session when the extension is first activated in a running Premiere Pro
// process — reopening the CEP panel window reloads client/index.html and
// client/main.js (the CEP browser-side code), but does NOT re-evaluate
// this .jsx file into that same engine session. If the live engine is
// still running an earlier build of this file (from before these newer
// commands existed), every NEW command would be undefined in that engine,
// while every command that existed at the time the engine last loaded
// this file (ping, createTextGraphic, probeSourceTextDeep) keeps working.
// HOSTSCRIPT_BUILD_ID + SUPPORTED_COMMANDS exist specifically to make that
// checkable directly, without guessing: call "ping" or
// "getAvailableCommands" and compare the returned build ID/command list
// against what's actually in this file on disk. Bump HOSTSCRIPT_BUILD_ID
// on every change to this file that should be verifiable after a reload.
var HOSTSCRIPT_BUILD_ID = "2026-07-15-bisect-r2";
var SUPPORTED_COMMANDS = [
  "ping",
  "getAvailableCommands",
  "echoPayload",
  "createTextGraphic",
  "probeSourceTextDeep",
  "inspectSourceTextRawBytes",
  "testRawBytesHelpers",
  "bisectHostScript",
];

/**
 * Single entry point called from client/main.js via evalScript. Takes one
 * JSON-encoded string (a { command, payload, requestId } request), returns
 * one JSON-encoded string ({ ok, requestId, result } or { ok, requestId,
 * error }) — evalScript can only pass/return strings, so both directions
 * go through JSON.parse/JSON.stringify.
 */
$._captionStudioBridge.dispatch = function (requestJsonString) {
  var requestId = null;
  try {
    var request = JSON.parse(requestJsonString);
    var command = request.command;
    var payload = request.payload || {};
    requestId = request.requestId || null;

    var response;
    if (command === "ping") {
      response = {
        ok: true,
        requestId: requestId,
        result: {
          pong: true,
          appVersion: (app && app.version) || null,
          hasActiveSequence: Boolean(app && app.project && app.project.activeSequence),
          hostscriptBuildId: HOSTSCRIPT_BUILD_ID,
          supportedCommands: SUPPORTED_COMMANDS,
        },
      };
    } else if (command === "getAvailableCommands") {
      response = $._captionStudioBridge.getAvailableCommands(payload, requestId);
    } else if (command === "echoPayload") {
      response = $._captionStudioBridge.echoPayload(payload, requestId);
    } else if (command === "createTextGraphic") {
      response = $._captionStudioBridge.createTextGraphic(payload, requestId);
    } else if (command === "probeSourceTextDeep") {
      response = $._captionStudioBridge.probeSourceTextDeep(payload, requestId);
    } else if (command === "inspectSourceTextRawBytes") {
      response = $._captionStudioBridge.inspectSourceTextRawBytes(payload, requestId);
    } else if (command === "testRawBytesHelpers") {
      response = $._captionStudioBridge.testRawBytesHelpers(payload, requestId);
    } else if (command === "bisectHostScript") {
      response = $._captionStudioBridge.bisectHostScript(payload, requestId);
    } else {
      response = { ok: false, requestId: requestId, error: "Unknown command: " + command, hostscriptBuildId: HOSTSCRIPT_BUILD_ID };
    }
    return JSON.stringify(response);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      requestId: requestId,
      error: "dispatch() threw: " + (err && err.message ? err.message : String(err)),
      stack: err && err.stack ? String(err.stack) : null,
      hostscriptBuildId: HOSTSCRIPT_BUILD_ID,
    });
  }
};

/**
 * Task 7: lets a caller confirm exactly what's loaded in the live
 * ExtendScript engine right now, independent of "ping" (in case "ping"
 * itself is somehow part of a stale load — defense in depth, though
 * "ping" is the oldest command in this file and the least likely to be
 * affected).
 */
$._captionStudioBridge.getAvailableCommands = function (payload, requestId) {
  return { ok: true, requestId: requestId, result: { hostscriptBuildId: HOSTSCRIPT_BUILD_ID, supportedCommands: SUPPORTED_COMMANDS } };
};

/**
 * Task 3: registered via the EXACT SAME pattern as the known-working
 * probeSourceTextDeep — a plain function assigned to
 * $._captionStudioBridge, wired into dispatch()'s if/else chain the same
 * way, returning a plain object (dispatch() does the one, single
 * JSON.stringify(response) call, same as every other command here; this
 * command does not pre-stringify its own result, since doing so would be
 * double-encoded by dispatch()'s own JSON.stringify() and would no longer
 * match the "exact same registration pattern" as every other working
 * command). Accepts one argument (the payload, an object or string as
 * sent by the caller) and echoes it back verbatim. No helper functions,
 * no Premiere APIs — deliberately placed here, immediately after
 * dispatch()/ping/getAvailableCommands near the TOP of the file, as far
 * as possible from bisectHostScript/testRawBytesHelpers/
 * inspectSourceTextRawBytes (all defined near the END of the file) — so
 * that if THIS fails while ping/createTextGraphic/probeSourceTextDeep
 * keep working, that is itself evidence about WHERE in the file the live
 * engine's loaded copy stops matching what's on disk.
 */
$._captionStudioBridge.echoPayload = function (payload, requestId) {
  return { ok: true, requestId: requestId, result: { received: payload, hostscriptBuildId: HOSTSCRIPT_BUILD_ID } };
};

// --- Multi-track clip detection helpers ---
//
// CONFIRMED REAL-HOST BUG this section exists to fix: the previous version
// hard-coded videoTrackIndex to 0 whenever the caller didn't pass one, and
// only ever checked THAT track's clip count for the inserted clip. On a
// sequence with many video tracks (observed: 13+), importMGT placed the
// clip somewhere else entirely, so the old code reported "did not appear
// to add a clip" even though it may well have — it just never looked
// anywhere but track 0. Every helper below operates across ALL video
// tracks, never a single hard-coded index.

/** Every video track's clip count and (name, start, end) for every clip on it — read defensively, never throws. */
function snapshotAllVideoTracks(sequence) {
  var snapshot = [];
  var trackCount = sequence.videoTracks.numTracks;
  for (var t = 0; t < trackCount; t++) {
    var track = sequence.videoTracks[t];
    var clipCount = track.clips.numItems;
    var clips = [];
    for (var c = 0; c < clipCount; c++) {
      var clip = track.clips[c];
      var name = null, start = null, end = null;
      try { name = clip.name; } catch (e) {}
      try { start = clip.start.seconds; } catch (e) {}
      try { end = clip.end.seconds; } catch (e) {}
      clips.push({ clipIndex: c, name: name, start: start, end: end });
    }
    snapshot.push({ trackIndex: t, clipCount: clipCount, clips: clips });
  }
  return snapshot;
}

function mapClipCounts(snapshot) {
  var counts = [];
  for (var i = 0; i < snapshot.length; i++) counts.push(snapshot[i].clipCount);
  return counts;
}

function clipKey(clip) {
  return (clip.name === null ? "null" : clip.name) + "|" + (clip.start === null ? "null" : clip.start.toFixed(6));
}

/** Tier 2 detection: a clip present in `after` with no (name, start) match anywhere in `before`, on ANY track. */
function findNewClipAcrossTracks(beforeSnapshot, afterSnapshot) {
  for (var t = 0; t < afterSnapshot.length; t++) {
    var beforeTrack = beforeSnapshot[t];
    var beforeKeys = {};
    if (beforeTrack) {
      for (var i = 0; i < beforeTrack.clips.length; i++) {
        beforeKeys[clipKey(beforeTrack.clips[i])] = true;
      }
    }
    var afterTrack = afterSnapshot[t];
    for (var j = 0; j < afterTrack.clips.length; j++) {
      var key = clipKey(afterTrack.clips[j]);
      if (!beforeKeys[key]) {
        return { trackIndex: t, clipIndex: afterTrack.clips[j].clipIndex };
      }
    }
  }
  return null;
}

/** Tier 3 (last resort): match by expected insertion time + MOGRT base filename, across every track. */
function findClipByTimeAndName(afterSnapshot, expectedStartSec, mogrtBaseName, toleranceSec) {
  var best = null;
  var bestDelta = null;
  for (var t = 0; t < afterSnapshot.length; t++) {
    var clips = afterSnapshot[t].clips;
    for (var c = 0; c < clips.length; c++) {
      var clip = clips[c];
      if (clip.start === null) continue;
      var delta = Math.abs(clip.start - expectedStartSec);
      if (delta > toleranceSec) continue;
      var nameMatches = mogrtBaseName && clip.name && clip.name.indexOf(mogrtBaseName) !== -1;
      if (nameMatches && (best === null || delta < bestDelta)) {
        best = { trackIndex: t, clipIndex: clip.clipIndex };
        bestDelta = delta;
      }
    }
  }
  return best;
}

function looksLikeTrackItem(value) {
  if (!value || typeof value !== "object") return false;
  try {
    return typeof value.name !== "undefined" && typeof value.start !== "undefined";
  } catch (e) {
    return false;
  }
}

/** Scans every video track for a live TrackItem reference, for logging purposes only (detection itself uses track/clip indexes, not this). */
function findTrackIndexForClip(sequence, trackItem) {
  for (var t = 0; t < sequence.videoTracks.numTracks; t++) {
    var track = sequence.videoTracks[t];
    for (var c = 0; c < track.clips.numItems; c++) {
      var candidate = track.clips[c];
      try {
        if (candidate === trackItem) return t;
        if (candidate.name === trackItem.name && Math.abs(candidate.start.seconds - trackItem.start.seconds) < 0.001) return t;
      } catch (e) {
        // keep scanning
      }
    }
  }
  return null;
}

function basenameNoExt(path) {
  var parts = String(path).split(/[\\\/]/);
  var file = parts[parts.length - 1];
  var dot = file.lastIndexOf(".");
  return dot > 0 ? file.substring(0, dot) : file;
}

function safeStringifyShallow(value) {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    var keys = [];
    for (var k in value) keys.push(k);
    return "{object, keys: " + keys.slice(0, 10).join(",") + "}";
  } catch (e) {
    return "(unstringifiable object)";
  }
}

/**
 * The proof of concept itself: import the given .mogrt at the playhead,
 * on a properly-resolved (never hard-coded) video/audio track, locate the
 * inserted clip via a three-tier detection strategy that checks every
 * video track (never assumes track 0 or the requested track), set its
 * duration, locate its "Source Text" param by displayName (never a fixed
 * index — same discipline the UXP diagnostics use, see
 * docs/MOGRT_DIAGNOSTIC.md), and attempt ComponentParam.setValue() — the
 * direct ExtendScript equivalent of the UXP call (createSetValueAction)
 * that threw "Illegal Parameter type". Every step's outcome is recorded
 * independently, and every requested/detected value is logged into
 * `result.diagnostics`, so a failure partway through still returns a full,
 * honest report of what did and didn't work.
 *
 * @param {{mogrtPath: string, text?: string, durationSec?: number, videoTrackIndex?: number}} payload
 */
$._captionStudioBridge.createTextGraphic = function (payload, requestId) {
  var diagnostics = [];
  function logStep(message) {
    diagnostics.push(message);
  }

  var mogrtPath = payload.mogrtPath;
  var sentinelText = payload.text || "__KERIS_CEP_TEST__";
  var durationSec = typeof payload.durationSec === "number" ? payload.durationSec : 2;
  var requestedVideoTrackIndex = typeof payload.videoTrackIndex === "number" ? payload.videoTrackIndex : null;

  if (!mogrtPath) {
    return { ok: false, requestId: requestId, error: "payload.mogrtPath is required.", diagnostics: diagnostics };
  }

  var project = app.project;
  if (!project) {
    return { ok: false, requestId: requestId, error: "No active Premiere project. Open a project first.", diagnostics: diagnostics };
  }
  var sequence = project.activeSequence;
  if (!sequence) {
    return { ok: false, requestId: requestId, error: "No active sequence. Open a sequence first.", diagnostics: diagnostics };
  }

  logStep("Active sequence: " + sequence.name);

  var videoTrackCount = sequence.videoTracks.numTracks;
  var audioTrackCount = sequence.audioTracks.numTracks;
  logStep("Video track count: " + videoTrackCount + ", audio track count: " + audioTrackCount);

  // Never hard-code track 0 — match the UXP insertion convention (topmost
  // video track; see src/ppro/timelineRange.js) when the caller didn't
  // request a specific, valid index.
  var videoTrackIndex;
  if (requestedVideoTrackIndex !== null && requestedVideoTrackIndex >= 0 && requestedVideoTrackIndex < videoTrackCount) {
    videoTrackIndex = requestedVideoTrackIndex;
    logStep("Using requested video track index: " + videoTrackIndex);
  } else {
    videoTrackIndex = videoTrackCount > 0 ? videoTrackCount - 1 : 0;
    logStep(
      "Requested video track index (" + requestedVideoTrackIndex + ") missing/out of range for " + videoTrackCount +
        " track(s) — falling back to the topmost video track: " + videoTrackIndex + "."
    );
  }

  // Audio track index must independently be valid — never assume it equals
  // videoTrackIndex (the exact same class of bug already confirmed and
  // fixed on the UXP side — see src/ppro/mogrt.js's resolveAudioTrackIndex
  // and docs/MOGRT_DIAGNOSTIC.md's sixth entry).
  var audioTrackIndex;
  if (audioTrackCount <= 0) {
    audioTrackIndex = 0;
    logStep("Sequence reports 0 audio tracks — using audioTrackIndex 0 (best effort).");
  } else if (videoTrackIndex < audioTrackCount) {
    audioTrackIndex = videoTrackIndex;
  } else {
    audioTrackIndex = audioTrackCount - 1;
    logStep("videoTrackIndex (" + videoTrackIndex + ") exceeds audio track count (" + audioTrackCount + ") — clamping audioTrackIndex to " + audioTrackIndex + ".");
  }

  var playheadTime;
  try {
    playheadTime = sequence.getPlayerPosition();
  } catch (err) {
    return { ok: false, requestId: requestId, error: "sequence.getPlayerPosition() threw: " + (err && err.message ? err.message : String(err)), diagnostics: diagnostics };
  }
  logStep("Requested insertion time: " + playheadTime.seconds.toFixed(3) + "s (" + playheadTime.ticks + " ticks).");
  logStep("Requested track indexes: video=" + videoTrackIndex + ", audio=" + audioTrackIndex + ".");

  var beforeSnapshot = snapshotAllVideoTracks(sequence);
  logStep("Before-import clip counts per video track: " + JSON.stringify(mapClipCounts(beforeSnapshot)));

  var importReturnValue;
  var importThrew = false;
  var importError = null;
  try {
    importReturnValue = sequence.importMGT(mogrtPath, playheadTime.ticks, videoTrackIndex, audioTrackIndex);
  } catch (err) {
    importThrew = true;
    importError = err && err.message ? err.message : String(err);
  }

  var importReturnType = typeof importReturnValue;
  logStep("importMGT() returned: type=" + importReturnType + ", value=" + safeStringifyShallow(importReturnValue));

  if (importThrew) {
    return { ok: false, requestId: requestId, error: "sequence.importMGT() threw: " + importError, diagnostics: diagnostics };
  }

  var afterSnapshot = snapshotAllVideoTracks(sequence);
  logStep("After-import clip counts per video track: " + JSON.stringify(mapClipCounts(afterSnapshot)));

  // Three-tier detection, per docs/CEP_BRIDGE_INVESTIGATION.md: (1) importMGT's
  // own return value, if it looks like a TrackItem; (2) a new/different clip
  // found by diffing every video track's clips before vs. after; (3) a clip
  // matching the expected insertion time + the MOGRT's base filename, again
  // across every track. Insertion is only reported as failed once all three
  // tiers — covering every video track — have been checked.
  var trackItem = null;
  var detectionMethod = null;
  var detectedTrackIndex = null;

  if (looksLikeTrackItem(importReturnValue)) {
    trackItem = importReturnValue;
    detectionMethod = "importMGT return value";
    logStep("Detected inserted clip via importMGT's own return value.");
  }

  if (!trackItem) {
    var newClip = findNewClipAcrossTracks(beforeSnapshot, afterSnapshot);
    if (newClip) {
      trackItem = sequence.videoTracks[newClip.trackIndex].clips[newClip.clipIndex];
      detectionMethod = "new clip diff across all tracks";
      detectedTrackIndex = newClip.trackIndex;
      logStep("Detected inserted clip via before/after diff on video track " + newClip.trackIndex + ", clip index " + newClip.clipIndex + ".");
    }
  }

  if (!trackItem) {
    var mogrtBaseName = basenameNoExt(mogrtPath);
    var byTimeAndName = findClipByTimeAndName(afterSnapshot, playheadTime.seconds, mogrtBaseName, 1.0);
    if (byTimeAndName) {
      trackItem = sequence.videoTracks[byTimeAndName.trackIndex].clips[byTimeAndName.clipIndex];
      detectionMethod = "time+name match";
      detectedTrackIndex = byTimeAndName.trackIndex;
      logStep("Detected inserted clip via time+name match on video track " + byTimeAndName.trackIndex + ", clip index " + byTimeAndName.clipIndex + ".");
    }
  }

  if (!trackItem) {
    logStep("No inserted clip could be detected on any of the " + videoTrackCount + " video track(s) after checking all three detection tiers.");
    return {
      ok: false,
      requestId: requestId,
      error:
        "importMGT() did not appear to add a clip to any video track (checked all " + videoTrackCount +
        " track(s); the call itself did not throw and returned " + importReturnType + ").",
      diagnostics: diagnostics,
      beforeClipCounts: mapClipCounts(beforeSnapshot),
      afterClipCounts: mapClipCounts(afterSnapshot),
    };
  }

  if (detectedTrackIndex === null) {
    detectedTrackIndex = findTrackIndexForClip(sequence, trackItem);
  }
  logStep('Inserted clip: "' + trackItem.name + '" on video track ' + (detectedTrackIndex === null ? "unknown" : detectedTrackIndex) + " via " + detectionMethod + ".");

  var result = {
    trackItemName: trackItem.name,
    start: trackItem.start.seconds,
    originalEnd: trackItem.end.seconds,
    detectedTrackIndex: detectedTrackIndex,
    detectionMethod: detectionMethod,
    importReturnType: importReturnType,
    requestedVideoTrackIndex: videoTrackIndex,
    requestedAudioTrackIndex: audioTrackIndex,
  };

  try {
    var newEnd = new Time();
    newEnd.seconds = trackItem.start.seconds + durationSec;
    trackItem.end = newEnd;
    result.end = trackItem.end.seconds;
    result.durationSetOk = true;
  } catch (err) {
    result.durationSetOk = false;
    result.durationSetError = err && err.message ? err.message : String(err);
  }

  var sourceTextParam = null;
  var componentDisplayName = null;
  try {
    for (var ci = 0; ci < trackItem.components.numItems; ci++) {
      var component = trackItem.components[ci];
      for (var pi = 0; pi < component.properties.numItems; pi++) {
        var param = component.properties[pi];
        if (param.displayName === "Source Text") {
          sourceTextParam = param;
          componentDisplayName = component.displayName;
          break;
        }
      }
      if (sourceTextParam) break;
    }
  } catch (err) {
    result.locateError = err && err.message ? err.message : String(err);
  }

  result.sourceTextFound = Boolean(sourceTextParam);
  if (!sourceTextParam) {
    logStep("No \"Source Text\" param found on the inserted clip's components.");
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  }

  result.componentDisplayName = componentDisplayName;
  try {
    result.isTimeVarying = sourceTextParam.isTimeVarying();
  } catch (err) {
    result.isTimeVarying = null;
  }
  try {
    result.areKeyframesSupported = sourceTextParam.areKeyframesSupported();
  } catch (err) {
    result.areKeyframesSupported = null;
  }
  logStep("Source Text found on \"" + componentDisplayName + "\" (isTimeVarying=" + result.isTimeVarying + ", areKeyframesSupported=" + result.areKeyframesSupported + ").");

  // THE test this whole proof of concept exists for: does
  // ComponentParam.setValue() accept a raw string where UXP's
  // createSetValueAction() threw "Illegal Parameter type"?
  try {
    sourceTextParam.setValue(sentinelText, true);
    result.sourceTextWriteOk = true;
    logStep("ComponentParam.setValue(\"" + sentinelText + "\", true) succeeded.");
  } catch (err) {
    result.sourceTextWriteOk = false;
    result.sourceTextWriteError = err && err.message ? err.message : String(err);
    logStep("ComponentParam.setValue() threw: " + result.sourceTextWriteError);
  }

  // Best-effort read-back — same caveat as every UXP read-back check in
  // this project: informative, not authoritative proof either way.
  try {
    result.sourceTextReadBack = sourceTextParam.getValue();
  } catch (err) {
    result.sourceTextReadBackError = err && err.message ? err.message : String(err);
  }

  result.diagnostics = diagnostics;
  return { ok: true, requestId: requestId, result: result };
};

// --- Deep Source Text parameter introspection (read-before-write) ---
//
// Real-host breakthrough (see docs/CEP_BRIDGE_INVESTIGATION.md Part 8):
// insertion is solved — importMGT() correctly lands the MOGRT on the
// resolved top video track, and the inserted graphic visibly shows its
// default "Hello World" text. The only remaining unknown is what shape
// ComponentParam.getValue()/.setValue() actually use for that visible
// text. probeSourceTextDeep() (below) answers that with evidence before
// attempting any more blind setValue() calls: it dumps everything
// reflect-visible about the Source Text ComponentParam and about
// getValue()'s return value BEFORE ever calling setValue(), and only
// attempts a write — a targeted, evidence-based one — if that dump
// reveals a genuinely constructible (plain-object or JSON-string) shape
// with an identifiable text-like field.
//
// GROUNDING: ExtendScript host object properties (like ComponentParam's)
// are typically NOT enumerable via plain `for...in` — the documented,
// reliable way to enumerate them is the built-in ExtendScript Reflection
// Interface: `value.reflect` returns a ReflectionObject with `.name`
// (class name), `.properties` (Array of ReflectionInfo, each with
// `.name`/`.dataType`/`.type`), and `.methods` (Array of ReflectionInfo,
// each with `.name`/`.arguments`) — see Adobe's JavaScript Tools Guide,
// "ExtendScript Reflection Interface" section. `.type` reports
// "readonly"/"readwrite"/"createonly"/"method", but Adobe's own developer
// community has documented cases (After Effects) where a property reports
// "readwrite" yet is still actually read-only at write time — so `.type`
// here is informational only, every read AND every write below stays
// wrapped in try/catch regardless of what `.type` claims.

// Bound the recursive dump so a deeply-nested or self-referential host
// object graph can't hang the ExtendScript engine or return a
// multi-megabyte JSON payload through evalScript.
var DUMP_MAX_DEPTH = 5;
var DUMP_NODE_BUDGET = 400;
var DUMP_MAX_ARRAY_ITEMS = 30;
var DUMP_MAX_TEXT_FIELD_MATCHES = 40;

function isArrayLikeValue(value) {
  try {
    return Object.prototype.toString.call(value) === "[object Array]";
  } catch (e) {
    return false;
  }
}

function isHostObjectWithReflect(value) {
  try {
    return typeof value === "object" && value !== null && typeof value.reflect !== "undefined" && typeof value.reflect.properties !== "undefined";
  } catch (e) {
    return false;
  }
}

function refAlreadyVisited(visitedRefs, value) {
  for (var i = 0; i < visitedRefs.length; i++) {
    if (visitedRefs[i] === value) return true;
  }
  return false;
}

/**
 * Recursively dumps ANY value — primitive, plain object, array, or
 * ExtendScript host object — into a plain, JSON-safe JS structure.
 * Host objects are enumerated via `.reflect` (see grounding note above);
 * plain (non-host) objects fall back to for...in, since they don't have a
 * meaningful .reflect. Depth/node-count/array-length are all bounded.
 */
function dumpValueDeep(value, depth, visitedRefs, budget) {
  if (typeof value === "undefined") return "undefined";
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "function") return "[function]";

  budget.count = budget.count + 1;
  if (budget.count > DUMP_NODE_BUDGET) return "[dump truncated: node budget exceeded]";
  if (depth > DUMP_MAX_DEPTH) return "[max depth reached]";
  if (refAlreadyVisited(visitedRefs, value)) return "[circular/repeated reference]";
  visitedRefs.push(value);

  if (isArrayLikeValue(value)) {
    var arr = [];
    var len = 0;
    try { len = value.length; } catch (eLen) { return "[array: could not read length: " + (eLen.message || eLen) + "]"; }
    var cap = Math.min(len, DUMP_MAX_ARRAY_ITEMS);
    for (var i = 0; i < cap; i++) {
      var item;
      try { item = value[i]; } catch (eItem) { item = "[error reading index " + i + ": " + (eItem.message || eItem) + "]"; }
      arr.push(dumpValueDeep(item, depth + 1, visitedRefs, budget));
    }
    if (len > cap) arr.push("[... " + (len - cap) + " more item(s) truncated]");
    return arr;
  }

  if (isHostObjectWithReflect(value)) {
    var out = { __hostObjectClass: null, __reflectProperties: [], __reflectMethods: [] };
    try { out.__hostObjectClass = value.reflect.name; } catch (eName) {}
    var propNames = [];
    try {
      var props = value.reflect.properties;
      for (var p = 0; p < props.length; p++) {
        var pname = null, pdt = null, ptype = null;
        try { pname = props[p].name; } catch (ePn) {}
        try { pdt = props[p].dataType; } catch (ePd) {}
        try { ptype = props[p].type; } catch (ePt) {}
        out.__reflectProperties.push({ name: pname, dataType: pdt, type: ptype });
        if (pname && pname !== "reflect") propNames.push(pname);
      }
    } catch (eProps) {
      out.__reflectPropertiesError = eProps && eProps.message ? eProps.message : String(eProps);
    }
    try {
      var methods = value.reflect.methods;
      for (var m = 0; m < methods.length; m++) {
        var mname = null, margs = [];
        try { mname = methods[m].name; } catch (eMn) {}
        try {
          var margsRaw = methods[m].arguments;
          for (var a = 0; a < margsRaw.length; a++) {
            var an = null;
            try { an = margsRaw[a].name; } catch (eAn) {}
            margs.push(an);
          }
        } catch (eArgs) {}
        out.__reflectMethods.push({ name: mname, arguments: margs });
      }
    } catch (eMethods) {
      out.__reflectMethodsError = eMethods && eMethods.message ? eMethods.message : String(eMethods);
    }
    for (var n = 0; n < propNames.length; n++) {
      var key = propNames[n];
      var fieldValue;
      try {
        fieldValue = value[key];
      } catch (eRead) {
        out[key] = "[error reading property: " + (eRead.message || eRead) + "]";
        continue;
      }
      out[key] = dumpValueDeep(fieldValue, depth + 1, visitedRefs, budget);
    }
    return out;
  }

  // Plain object, or a host object whose .reflect didn't work — fall back
  // to for...in (works for plain JS objects; for host objects it usually
  // yields nothing, which is itself informative and gets reported below).
  var plain = {};
  var sawAnyKey = false;
  try {
    for (var k in value) {
      sawAnyKey = true;
      var v;
      try { v = value[k]; } catch (eFor) { v = "[error reading property '" + k + "': " + (eFor.message || eFor) + "]"; }
      plain[k] = dumpValueDeep(v, depth + 1, visitedRefs, budget);
    }
  } catch (eEnum) {
    return "[object: for...in enumeration threw: " + (eEnum.message || eEnum) + "]";
  }
  if (!sawAnyKey) return "[object: no enumerable properties via for...in, and no working .reflect]";
  return plain;
}

var TEXT_LIKE_FIELD_NAME_PATTERN = /text|value|string|content|run/i;

/**
 * Walks an already-dumped (plain, JSON-safe) tree looking for keys whose
 * NAME suggests they might hold the visible text — textEditValue,
 * fontTextRunLength, text, value, runs, etc. — without assuming any one
 * of them is THE answer. Records the live parent object + key too (not
 * just a path string) so a caller can mutate the exact field directly.
 */
function collectTextLikeFields(node, pathPrefix, out, depth) {
  if (out.length >= DUMP_MAX_TEXT_FIELD_MATCHES) return;
  if (depth > DUMP_MAX_DEPTH) return;
  if (node === null || typeof node !== "object") return;
  if (isArrayLikeValue(node)) {
    for (var i = 0; i < node.length; i++) {
      if (out.length >= DUMP_MAX_TEXT_FIELD_MATCHES) return;
      collectTextLikeFields(node[i], pathPrefix + "[" + i + "]", out, depth + 1);
    }
    return;
  }
  for (var k in node) {
    if (out.length >= DUMP_MAX_TEXT_FIELD_MATCHES) return;
    var childPath = pathPrefix ? pathPrefix + "." + k : k;
    if (TEXT_LIKE_FIELD_NAME_PATTERN.test(k)) {
      out.push({ path: childPath, key: k, parent: node, valuePreview: safeStringifyShallow(node[k]) });
    }
    collectTextLikeFields(node[k], childPath, out, depth + 1);
  }
}

/** Bounded before/after leaf-level diff over two already-dumped plain trees. */
function diffDumpedTrees(before, after, pathPrefix, out) {
  if (out.length >= 200) return;
  var beforeIsObj = before !== null && typeof before === "object";
  var afterIsObj = after !== null && typeof after === "object";
  if (!beforeIsObj && !afterIsObj) {
    if (before !== after) out.push({ path: pathPrefix || "(root)", before: before, after: after });
    return;
  }
  if (beforeIsObj !== afterIsObj) {
    out.push({ path: pathPrefix || "(root)", before: before, after: after });
    return;
  }
  var beforeIsArr = isArrayLikeValue(before);
  var afterIsArr = isArrayLikeValue(after);
  if (beforeIsArr !== afterIsArr) {
    out.push({ path: pathPrefix || "(root)", before: before, after: after });
    return;
  }
  if (beforeIsArr) {
    var maxLen = Math.max(before.length, after.length);
    for (var i = 0; i < maxLen; i++) {
      if (out.length >= 200) return;
      diffDumpedTrees(before[i], after[i], pathPrefix + "[" + i + "]", out);
    }
    return;
  }
  var seenKeys = {};
  var k;
  for (k in before) {
    if (out.length >= 200) return;
    seenKeys[k] = true;
    var childPath = pathPrefix ? pathPrefix + "." + k : k;
    diffDumpedTrees(before[k], after[k], childPath, out);
  }
  for (k in after) {
    if (out.length >= 200) return;
    if (seenKeys[k]) continue;
    var childPath2 = pathPrefix ? pathPrefix + "." + k : k;
    diffDumpedTrees(undefined, after[k], childPath2, out);
  }
}

/**
 * Deep, read-first investigation of the Source Text ComponentParam.
 * Inserts the given .mogrt (reusing the same track resolution + three-tier
 * detection as createTextGraphic — see its header comment and
 * docs/CEP_BRIDGE_INVESTIGATION.md Part 7), locates the "Source Text"
 * param, dumps everything reflect-visible about the param object AND
 * about getValue()'s return value, and — ONLY if that dump reveals a
 * plain-object or JSON-string shape with an identifiable text-like field —
 * clones it, changes just that field, calls setValue() with the modified
 * structure, and reports a full before/after diff. Never calls setValue()
 * with a blind guess (e.g. a raw replacement string) — that hypothesis
 * was already tested and confirmed to throw "Illegal Parameter type"
 * (docs/MOGRT_DIAGNOSTIC.md).
 *
 * @param {{mogrtPath: string, videoTrackIndex?: number, newTextValue?: string}} payload
 */
$._captionStudioBridge.probeSourceTextDeep = function (payload, requestId) {
  var diagnostics = [];
  function logStep(message) {
    diagnostics.push(message);
  }

  var mogrtPath = payload.mogrtPath;
  var requestedVideoTrackIndex = typeof payload.videoTrackIndex === "number" ? payload.videoTrackIndex : null;
  var newTextValue = payload.newTextValue || "__KERIS_SOURCE_TEXT_PROBE__";

  if (!mogrtPath) {
    return { ok: false, requestId: requestId, error: "payload.mogrtPath is required.", diagnostics: diagnostics };
  }

  var project = app.project;
  if (!project) {
    return { ok: false, requestId: requestId, error: "No active Premiere project. Open a project first.", diagnostics: diagnostics };
  }
  var sequence = project.activeSequence;
  if (!sequence) {
    return { ok: false, requestId: requestId, error: "No active sequence. Open a sequence first.", diagnostics: diagnostics };
  }
  logStep("Active sequence: " + sequence.name);

  var videoTrackCount = sequence.videoTracks.numTracks;
  var audioTrackCount = sequence.audioTracks.numTracks;
  logStep("Video track count: " + videoTrackCount + ", audio track count: " + audioTrackCount);

  var videoTrackIndex;
  if (requestedVideoTrackIndex !== null && requestedVideoTrackIndex >= 0 && requestedVideoTrackIndex < videoTrackCount) {
    videoTrackIndex = requestedVideoTrackIndex;
    logStep("Using requested video track index: " + videoTrackIndex);
  } else {
    videoTrackIndex = videoTrackCount > 0 ? videoTrackCount - 1 : 0;
    logStep(
      "Requested video track index (" + requestedVideoTrackIndex + ") missing/out of range for " + videoTrackCount +
        " track(s) — falling back to the topmost video track: " + videoTrackIndex + "."
    );
  }

  var audioTrackIndex;
  if (audioTrackCount <= 0) {
    audioTrackIndex = 0;
    logStep("Sequence reports 0 audio tracks — using audioTrackIndex 0 (best effort).");
  } else if (videoTrackIndex < audioTrackCount) {
    audioTrackIndex = videoTrackIndex;
  } else {
    audioTrackIndex = audioTrackCount - 1;
    logStep("videoTrackIndex (" + videoTrackIndex + ") exceeds audio track count (" + audioTrackCount + ") — clamping audioTrackIndex to " + audioTrackIndex + ".");
  }

  var playheadTime;
  try {
    playheadTime = sequence.getPlayerPosition();
  } catch (errPh) {
    return {
      ok: false,
      requestId: requestId,
      error: "sequence.getPlayerPosition() threw: " + (errPh && errPh.message ? errPh.message : String(errPh)),
      diagnostics: diagnostics,
    };
  }
  logStep(
    "Requested insertion time: " + playheadTime.seconds.toFixed(3) + "s (" + playheadTime.ticks + " ticks). Requested tracks: video=" +
      videoTrackIndex + ", audio=" + audioTrackIndex + "."
  );

  var beforeSnapshot = snapshotAllVideoTracks(sequence);
  logStep("Before-import clip counts per video track: " + JSON.stringify(mapClipCounts(beforeSnapshot)));

  var importReturnValue;
  var importThrew = false;
  var importError = null;
  try {
    importReturnValue = sequence.importMGT(mogrtPath, playheadTime.ticks, videoTrackIndex, audioTrackIndex);
  } catch (errImport) {
    importThrew = true;
    importError = errImport && errImport.message ? errImport.message : String(errImport);
  }
  var importReturnType = typeof importReturnValue;
  logStep("importMGT() returned: type=" + importReturnType + ", value=" + safeStringifyShallow(importReturnValue));

  if (importThrew) {
    return { ok: false, requestId: requestId, error: "sequence.importMGT() threw: " + importError, diagnostics: diagnostics };
  }

  var afterSnapshot = snapshotAllVideoTracks(sequence);
  logStep("After-import clip counts per video track: " + JSON.stringify(mapClipCounts(afterSnapshot)));

  var trackItem = null;
  var detectionMethod = null;
  var detectedTrackIndex = null;

  if (looksLikeTrackItem(importReturnValue)) {
    trackItem = importReturnValue;
    detectionMethod = "importMGT return value";
  }
  if (!trackItem) {
    var newClip = findNewClipAcrossTracks(beforeSnapshot, afterSnapshot);
    if (newClip) {
      trackItem = sequence.videoTracks[newClip.trackIndex].clips[newClip.clipIndex];
      detectionMethod = "new clip diff across all tracks";
      detectedTrackIndex = newClip.trackIndex;
    }
  }
  if (!trackItem) {
    var mogrtBaseName = basenameNoExt(mogrtPath);
    var byTimeAndName = findClipByTimeAndName(afterSnapshot, playheadTime.seconds, mogrtBaseName, 1.0);
    if (byTimeAndName) {
      trackItem = sequence.videoTracks[byTimeAndName.trackIndex].clips[byTimeAndName.clipIndex];
      detectionMethod = "time+name match";
      detectedTrackIndex = byTimeAndName.trackIndex;
    }
  }
  if (!trackItem) {
    logStep("No inserted clip could be detected on any of the " + videoTrackCount + " video track(s) after checking all three detection tiers.");
    return {
      ok: false,
      requestId: requestId,
      error:
        "importMGT() did not appear to add a clip to any video track (checked all " + videoTrackCount +
        " track(s); the call itself did not throw and returned " + importReturnType + ").",
      diagnostics: diagnostics,
      beforeClipCounts: mapClipCounts(beforeSnapshot),
      afterClipCounts: mapClipCounts(afterSnapshot),
    };
  }
  if (detectedTrackIndex === null) {
    detectedTrackIndex = findTrackIndexForClip(sequence, trackItem);
  }
  logStep('Inserted clip: "' + trackItem.name + '" on video track ' + (detectedTrackIndex === null ? "unknown" : detectedTrackIndex) + " via " + detectionMethod + ".");

  // --- Locate the Source Text param, logging every component/param name seen along the way ---
  var sourceTextParam = null;
  var componentDisplayName = null;
  var allParamNamesSeen = [];
  try {
    for (var ci = 0; ci < trackItem.components.numItems; ci++) {
      var component = trackItem.components[ci];
      var compName = null;
      try { compName = component.displayName; } catch (eCompName) {}
      for (var pi = 0; pi < component.properties.numItems; pi++) {
        var param = component.properties[pi];
        var pDisplayName = null;
        try { pDisplayName = param.displayName; } catch (ePName) {}
        allParamNamesSeen.push((compName || "?") + " / " + (pDisplayName || "?"));
        if (pDisplayName === "Source Text") {
          sourceTextParam = param;
          componentDisplayName = compName;
        }
      }
    }
  } catch (errLocate) {
    logStep("Error while enumerating components/params: " + (errLocate && errLocate.message ? errLocate.message : String(errLocate)));
  }
  logStep("All component/param names seen on this clip: " + JSON.stringify(allParamNamesSeen));

  var result = {
    trackItemName: trackItem.name,
    detectedTrackIndex: detectedTrackIndex,
    detectionMethod: detectionMethod,
    componentAndParamNamesSeen: allParamNamesSeen,
  };

  if (!sourceTextParam) {
    logStep(
      'No "Source Text" param found on the inserted clip\'s components — the visible text is on another parameter entirely ' +
        "(see componentAndParamNamesSeen above), or under a different displayName on this host version."
    );
    result.sourceTextFound = false;
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  }

  result.sourceTextFound = true;
  result.componentDisplayName = componentDisplayName;
  logStep('Source Text param located on component "' + componentDisplayName + '".');

  // --- Dump EVERYTHING about the param itself, before ever calling setValue() ---
  var paramDumpBudget = { count: 0 };
  var paramDump = dumpValueDeep(sourceTextParam, 0, [], paramDumpBudget);
  result.paramDump = paramDump;
  try { result.paramMatchName = sourceTextParam.matchName; } catch (eMatch) { result.paramMatchName = undefined; }
  try { result.paramDisplayName = sourceTextParam.displayName; } catch (eDisp) {}
  try { result.paramTypeofSelf = typeof sourceTextParam; } catch (eTos) {}
  try {
    result.paramConstructorName = sourceTextParam.constructor ? String(sourceTextParam.constructor.name) : null;
  } catch (eCtor) {
    result.paramConstructorName = "[error reading constructor: " + (eCtor.message || eCtor) + "]";
  }
  logStep("Param dump complete (node budget used: " + paramDumpBudget.count + ").");

  // --- The core question: what does getValue() actually return? ---
  var rawValue;
  var getValueThrew = false;
  var getValueError = null;
  var getValueErrorLine = null;
  try {
    rawValue = sourceTextParam.getValue();
  } catch (errGet) {
    getValueThrew = true;
    getValueError = errGet && errGet.message ? errGet.message : String(errGet);
    getValueErrorLine = errGet && typeof errGet.line !== "undefined" ? errGet.line : null;
  }

  if (getValueThrew) {
    logStep(
      "getValue() THREW on the initial read (before any write attempt): " + getValueError +
        (getValueErrorLine !== null ? " (line " + getValueErrorLine + ")" : "")
    );
    result.getValueThrew = true;
    result.getValueThrowLocation = "initial getValue() call on the located Source Text param";
    result.getValueError = getValueError;
    result.getValueErrorLine = getValueErrorLine;
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  }

  var rawType = typeof rawValue;
  result.getValueRawType = rawType;
  logStep("getValue() succeeded. typeof result: " + rawType);

  var rawValueDumpBudget = { count: 0 };
  var rawValueDump = dumpValueDeep(rawValue, 0, [], rawValueDumpBudget);
  result.getValueDump = rawValueDump;
  logStep("getValue() result dump complete (node budget used: " + rawValueDumpBudget.count + ").");

  // If it's a string, see if it's actually JSON underneath.
  var parsedFromJsonString = null;
  var wasJsonString = false;
  if (rawType === "string") {
    try {
      var attempted = JSON.parse(rawValue);
      if (attempted !== null && typeof attempted === "object") {
        parsedFromJsonString = attempted;
        wasJsonString = true;
        logStep("getValue() returned a string that IS valid JSON — parsed into a structured object.");
      }
    } catch (eParse) {
      logStep("getValue() returned a plain string (not JSON — JSON.parse failed: " + (eParse.message || eParse) + ").");
    }
  }

  // Determine the "structured base" to search for a text-like field in,
  // per the task's read-before-write discipline: a plain object
  // (getValueDump already flattened any host sub-object via .reflect), a
  // JSON-parsed string, or neither.
  var structuredBase = null;
  var structuredKind = null; // "plain-object" | "json-string" | "host-object-with-reflect" | "none"
  if (wasJsonString) {
    structuredBase = parsedFromJsonString;
    structuredKind = "json-string";
  } else if (rawType === "object" && rawValue !== null) {
    if (isHostObjectWithReflect(rawValue)) {
      structuredKind = "host-object-with-reflect";
      // Use the already-computed, safe plain dump (rawValueDump) as the
      // structured base for locating candidate fields and for diffing —
      // NOT the live host object itself, which for...in/JSON.stringify
      // can't safely round-trip.
      structuredBase = rawValueDump;
    } else {
      structuredKind = "plain-object";
      structuredBase = rawValue;
    }
  } else {
    structuredKind = "none";
  }
  result.structuredKind = structuredKind;
  logStep("Structured shape classification: " + structuredKind + ".");

  // --- Search for text-like fields, wherever they are ---
  var textFieldCandidates = [];
  if (structuredBase !== null) {
    collectTextLikeFields(structuredBase, "", textFieldCandidates, 0);
  }
  result.textFieldCandidates = [];
  for (var tf = 0; tf < textFieldCandidates.length; tf++) {
    result.textFieldCandidates.push({
      path: textFieldCandidates[tf].path,
      key: textFieldCandidates[tf].key,
      valuePreview: textFieldCandidates[tf].valuePreview,
    });
  }
  logStep("Text-like field candidates found: " + JSON.stringify(result.textFieldCandidates));

  // --- Only attempt a write if we found a genuinely constructible
  // structured shape (plain object or JSON string) with a text-like
  // field — never a live host object (no evidence a fabricated plain copy
  // is what setValue() expects for that), and never a blind raw-string
  // replacement (already confirmed to throw "Illegal Parameter type"). ---
  if (structuredKind !== "plain-object" && structuredKind !== "json-string") {
    logStep(
      'Skipping the write test: getValue()\'s shape is "' + structuredKind + '", not a plain object or JSON string, ' +
        "so there is no evidence-based way yet to construct a valid replacement value. No setValue() call is made here."
    );
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  }

  if (!textFieldCandidates.length) {
    logStep(
      "Skipping the write test: getValue() returned a structured (" + structuredKind +
        ") shape, but no text-like field name was found in it to modify."
    );
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  }

  // Prefer an exact "textEditValue" match, then "text", then the first
  // candidate whose current value is a non-empty string.
  var chosen = null;
  for (var c1 = 0; c1 < textFieldCandidates.length; c1++) {
    if (textFieldCandidates[c1].key === "textEditValue") {
      chosen = textFieldCandidates[c1];
      break;
    }
  }
  if (!chosen) {
    for (var c2 = 0; c2 < textFieldCandidates.length; c2++) {
      if (textFieldCandidates[c2].key === "text") {
        chosen = textFieldCandidates[c2];
        break;
      }
    }
  }
  if (!chosen) {
    for (var c3 = 0; c3 < textFieldCandidates.length; c3++) {
      var candidateValue = textFieldCandidates[c3].parent[textFieldCandidates[c3].key];
      if (typeof candidateValue === "string" && candidateValue.length > 0) {
        chosen = textFieldCandidates[c3];
        break;
      }
    }
  }
  if (!chosen) chosen = textFieldCandidates[0];

  logStep('Chosen field to modify for the write test: "' + chosen.path + '" (current value preview: ' + chosen.valuePreview + ").");
  result.chosenWriteFieldPath = chosen.path;

  // Clone the structured base (JSON round-trip — safe because
  // structuredBase is already a plain, JSON-safe dump, never the live
  // host object) and modify ONLY the chosen field.
  var beforeClone, modifiedClone;
  try {
    var serialized = JSON.stringify(structuredBase);
    beforeClone = JSON.parse(serialized);
    modifiedClone = JSON.parse(serialized);
  } catch (eClone) {
    logStep("Could not JSON-clone the structured value — skipping the write test: " + (eClone.message || eClone));
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  }

  // Re-locate the same field on modifiedClone (fresh object graph after
  // the clone, so `chosen.parent` from before no longer applies) by
  // matching the recorded path.
  var modifiedCandidates = [];
  collectTextLikeFields(modifiedClone, "", modifiedCandidates, 0);
  var modifiedTarget = null;
  for (var mc = 0; mc < modifiedCandidates.length; mc++) {
    if (modifiedCandidates[mc].path === chosen.path) {
      modifiedTarget = modifiedCandidates[mc];
      break;
    }
  }
  if (!modifiedTarget) {
    logStep("Could not re-locate the chosen field on the cloned structure — skipping the write test.");
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  }
  modifiedTarget.parent[modifiedTarget.key] = newTextValue;

  var valueToWrite = structuredKind === "json-string" ? JSON.stringify(modifiedClone) : modifiedClone;

  var writeOk = false;
  var writeError = null;
  var writeErrorLine = null;
  try {
    sourceTextParam.setValue(valueToWrite, true);
    writeOk = true;
    logStep("setValue() with the modified structured value SUCCEEDED.");
  } catch (errSet) {
    writeError = errSet && errSet.message ? errSet.message : String(errSet);
    writeErrorLine = errSet && typeof errSet.line !== "undefined" ? errSet.line : null;
    logStep("setValue() with the modified structured value THREW: " + writeError + (writeErrorLine !== null ? " (line " + writeErrorLine + ")" : ""));
  }
  result.sourceTextWriteOk = writeOk;
  result.sourceTextWriteError = writeError;
  result.sourceTextWriteErrorLine = writeErrorLine;

  // --- Read back and produce a complete before/after diff ---
  var afterRawValue;
  var readBackThrew = false;
  var readBackError = null;
  try {
    afterRawValue = sourceTextParam.getValue();
  } catch (errReadBack) {
    readBackThrew = true;
    readBackError = errReadBack && errReadBack.message ? errReadBack.message : String(errReadBack);
    logStep("getValue() THREW on the post-write read-back: " + readBackError);
  }

  if (readBackThrew) {
    result.readBackThrew = true;
    result.readBackThrowLocation = "getValue() call immediately after setValue()";
    result.readBackError = readBackError;
  } else {
    var afterDumpBudget = { count: 0 };
    var afterDump = dumpValueDeep(afterRawValue, 0, [], afterDumpBudget);
    result.getValueDumpAfter = afterDump;

    var beforeForDiff = wasJsonString ? beforeClone : structuredBase;
    var afterForDiff = afterDump;
    if (wasJsonString && typeof afterRawValue === "string") {
      try {
        afterForDiff = JSON.parse(afterRawValue);
      } catch (eParseAfter) {
        // Fall back to the raw dump if the post-write value isn't JSON anymore.
      }
    }

    var diff = [];
    diffDumpedTrees(beforeForDiff, afterForDiff, "", diff);
    result.beforeAfterDiff = diff;
    logStep("Before/after diff computed: " + diff.length + " differing leaf value(s).");
  }

  result.diagnostics = diagnostics;
  return { ok: true, requestId: requestId, result: result };
};

// --- Inspect Source Text raw bytes (byte-level, never calls setValue) ---
//
// Real-host anomaly this exists to explain: a previous probeSourceTextDeep()
// run reported typeof getValue() === "string", the UI's rendered preview of
// that string LOOKED like "{}", yet JSON.parse(rawValue) failed and the
// value was classified as structuredKind "none". That combination only
// makes sense if the string isn't actually the two visible characters
// "{}" — e.g. it could carry a leading UTF-8 BOM, embedded null
// characters, surrounding whitespace, or non-ASCII/control characters
// that a plain rendered preview wouldn't show but which break
// JSON.parse(). This diagnostic answers that with hard evidence — exact
// length, every character code, JSON.stringify() of the raw string (which
// reveals hidden characters via escape sequences), and several
// JSON.parse() normalization attempts — before any more Premiere API
// experiments or setValue() calls.

var RAW_BYTES_CHAR_DUMP_CAP = 4000;

function charCodeHexDump(str, maxChars) {
  var out = [];
  var len = Math.min(str.length, maxChars);
  for (var i = 0; i < len; i++) {
    var code = str.charCodeAt(i);
    var hex = code.toString(16);
    while (hex.length < 4) hex = "0" + hex;
    out.push({ index: i, char: str.charAt(i), code: code, hex: "0x" + hex });
  }
  return out;
}

/**
 * Attempts JSON.parse() on `str`, capturing success/value or the exact
 * exception message and (best-effort, parsed out of the message text —
 * ExtendScript's JSON implementation doesn't expose a structured position
 * field) the character position it failed at, plus ExtendScript's
 * Error.line where available. Also records JSON.stringify(str) so hidden
 * characters in the INPUT to this particular attempt are visible too.
 */
function tryJsonParse(label, str) {
  var entry = { label: label, ok: false, value: undefined, error: null, errorPosition: null, errorLine: null, inputJsonStringify: null, inputLength: str.length };
  try {
    entry.inputJsonStringify = JSON.stringify(str);
  } catch (eStr) {
    entry.inputJsonStringify = "[could not JSON.stringify the input: " + (eStr.message || eStr) + "]";
  }
  try {
    entry.value = JSON.parse(str);
    entry.ok = true;
  } catch (eParse) {
    entry.error = eParse && eParse.message ? eParse.message : String(eParse);
    var posMatch = entry.error.match(/position\s+(\d+)/i);
    if (posMatch) entry.errorPosition = parseInt(posMatch[1], 10);
    if (eParse && typeof eParse.line !== "undefined") entry.errorLine = eParse.line;
  }
  return entry;
}

/**
 * Writes `data` (JSON-stringified, pretty-printed) to a file in the OS
 * temp folder via ExtendScript's core File/Folder API (Folder.temp — a
 * long-standing, documented ExtendScript global, not Premiere-specific).
 */
function saveDiagnosticJson(data, fileName) {
  try {
    var file = new File(Folder.temp.fsName + "/" + fileName);
    file.encoding = "UTF-8";
    var opened = file.open("w");
    if (!opened) {
      return { ok: false, error: "File.open('w') returned false for " + file.fsName };
    }
    file.write(JSON.stringify(data, null, 2));
    file.close();
    return { ok: true, path: file.fsName };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Builds the standardized fatal-failure envelope this command returns
 * whenever ANYTHING inside its top-level try/catch throws -- always a
 * plain JS object (never lets an exception escape dispatch()'s own
 * JSON.stringify), always tagged with the pipeline `stage` it failed
 * during (see STAGE_* constants below) so a real-host run pinpoints
 * exactly where, without guessing.
 */
function buildFatalFailure(requestId, stage, diagnostics, err) {
  var message = err && err.message ? err.message : String(err);
  var line = err && typeof err.line !== "undefined" ? err.line : null;
  var fileName = err && typeof err.fileName !== "undefined" ? err.fileName : null;
  var stack = err && typeof err.stack !== "undefined" ? String(err.stack) : null;
  diagnostics.push("FATAL at stage \"" + stage + "\": " + message + (line !== null ? " (line " + line + ")" : ""));
  return {
    ok: false,
    requestId: requestId,
    stage: stage,
    error: message,
    errorLine: line,
    errorFileName: fileName,
    errorStack: stack,
    diagnostics: diagnostics,
  };
}

var STAGE_ARGUMENT_PARSING = "argument-parsing";
var STAGE_MOGRT_INSERTION = "mogrt-insertion";
var STAGE_SOURCE_TEXT_LOOKUP = "source-text-lookup";
var STAGE_RAW_STRING_INSPECTION = "raw-string-inspection";
var STAGE_JSON_SERIALIZATION = "json-serialization";
var STAGE_TEMP_FILE_WRITING = "temp-file-writing";

/**
 * Removes every null character (code point 0) from a string via a plain
 * character-by-character loop -- deliberately NOT a regex or string
 * escape-sequence literal. ExtendScript's older JS engine is the one
 * thing in this whole file that has repeatedly proven unpredictable
 * around escape-sequence handling during this project's own tooling, so
 * this sidesteps that entire class of risk (matches the user's explicit
 * "Unicode escape handling that ExtendScript may parse differently"
 * concern) with a construct that has no escape sequences to misparse at
 * all -- just charCodeAt(i) === 0.
 */
function stripNullChars(s) {
  var out = "";
  for (var i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) !== 0) out += s.charAt(i);
  }
  return out;
}

/**
 * Inserts the given .mogrt, locates its Source Text ComponentParam (same
 * track resolution + three-tier detection as createTextGraphic() /
 * probeSourceTextDeep()), calls getValue() ONCE, and does an exhaustive
 * byte-level inspection of the resulting string. Never calls setValue().
 *
 * The ENTIRE body below runs inside one top-level try/catch (task 3): any
 * exception at any stage -- including ones outside every inner try/catch
 * already present in the individual steps -- is caught here and turned
 * into a plain JS object with `ok:false`, `stage`, `error`,
 * `errorLine`/`errorFileName`/`errorStack` (task 4), so dispatch()'s own
 * JSON.stringify(response) always has a real object to serialize instead
 * of an exception escaping past it. `stage` is updated right before each
 * major phase begins (task 5): argument-parsing, mogrt-insertion,
 * source-text-lookup, raw-string-inspection, json-serialization,
 * temp-file-writing -- specifically so a real-host "EvalScript error."
 * (CEP's own fallback string for an ExtendScript-side fault that escapes
 * normal script-level try/catch) can, on the next run, be narrowed down:
 * if this wrapper is reached and still returns valid JSON with a `stage`
 * value, the crash was a normal catchable exception at that stage; if
 * "EvalScript error." still comes back with NO JSON at all, the fault is
 * happening below the JS engine's own catch mechanism (most plausible
 * culprit: the file I/O in temp-file-writing -- see `payload.skipFileSave`
 * below, and the standalone `testRawBytesHelpers` command, which exercises
 * the exact same byte/JSON helpers with zero Premiere host object access
 * so that hypothesis can be tested in isolation).
 *
 * @param {{mogrtPath: string, videoTrackIndex?: number, skipFileSave?: boolean}} payload
 */
$._captionStudioBridge.inspectSourceTextRawBytes = function (payload, requestId) {
  var diagnostics = [];
  function logStep(message) {
    diagnostics.push(message);
  }
  var stage = STAGE_ARGUMENT_PARSING;

  try {
    var mogrtPath = payload.mogrtPath;
    var requestedVideoTrackIndex = typeof payload.videoTrackIndex === "number" ? payload.videoTrackIndex : null;
    var skipFileSave = Boolean(payload.skipFileSave);

    if (!mogrtPath) {
      return { ok: false, requestId: requestId, stage: stage, error: "payload.mogrtPath is required.", diagnostics: diagnostics };
    }

    var project = app.project;
    if (!project) {
      return { ok: false, requestId: requestId, stage: stage, error: "No active Premiere project. Open a project first.", diagnostics: diagnostics };
    }
    var sequence = project.activeSequence;
    if (!sequence) {
      return { ok: false, requestId: requestId, stage: stage, error: "No active sequence. Open a sequence first.", diagnostics: diagnostics };
    }
    logStep("Active sequence: " + sequence.name);

    var videoTrackCount = sequence.videoTracks.numTracks;
    var audioTrackCount = sequence.audioTracks.numTracks;
    logStep("Video track count: " + videoTrackCount + ", audio track count: " + audioTrackCount);

    var videoTrackIndex;
    if (requestedVideoTrackIndex !== null && requestedVideoTrackIndex >= 0 && requestedVideoTrackIndex < videoTrackCount) {
      videoTrackIndex = requestedVideoTrackIndex;
      logStep("Using requested video track index: " + videoTrackIndex);
    } else {
      videoTrackIndex = videoTrackCount > 0 ? videoTrackCount - 1 : 0;
      logStep(
        "Requested video track index (" + requestedVideoTrackIndex + ") missing/out of range for " + videoTrackCount +
          " track(s) -- falling back to the topmost video track: " + videoTrackIndex + "."
      );
    }

    var audioTrackIndex;
    if (audioTrackCount <= 0) {
      audioTrackIndex = 0;
      logStep("Sequence reports 0 audio tracks -- using audioTrackIndex 0 (best effort).");
    } else if (videoTrackIndex < audioTrackCount) {
      audioTrackIndex = videoTrackIndex;
    } else {
      audioTrackIndex = audioTrackCount - 1;
      logStep("videoTrackIndex (" + videoTrackIndex + ") exceeds audio track count (" + audioTrackCount + ") -- clamping audioTrackIndex to " + audioTrackIndex + ".");
    }

    var playheadTime = sequence.getPlayerPosition();
    logStep(
      "Requested insertion time: " + playheadTime.seconds.toFixed(3) + "s (" + playheadTime.ticks + " ticks). Requested tracks: video=" +
        videoTrackIndex + ", audio=" + audioTrackIndex + "."
    );

    // --- Stage: mogrt-insertion ---
    stage = STAGE_MOGRT_INSERTION;

    var beforeSnapshot = snapshotAllVideoTracks(sequence);
    var importReturnValue;
    var importThrew = false;
    var importError = null;
    try {
      importReturnValue = sequence.importMGT(mogrtPath, playheadTime.ticks, videoTrackIndex, audioTrackIndex);
    } catch (errImport) {
      importThrew = true;
      importError = errImport && errImport.message ? errImport.message : String(errImport);
    }
    var importReturnType = typeof importReturnValue;
    logStep("importMGT() returned: type=" + importReturnType + ", value=" + safeStringifyShallow(importReturnValue));

    if (importThrew) {
      return { ok: false, requestId: requestId, stage: stage, error: "sequence.importMGT() threw: " + importError, diagnostics: diagnostics };
    }

    var afterSnapshot = snapshotAllVideoTracks(sequence);

    var trackItem = null;
    var detectionMethod = null;
    var detectedTrackIndex = null;

    if (looksLikeTrackItem(importReturnValue)) {
      trackItem = importReturnValue;
      detectionMethod = "importMGT return value";
    }
    if (!trackItem) {
      var newClip = findNewClipAcrossTracks(beforeSnapshot, afterSnapshot);
      if (newClip) {
        trackItem = sequence.videoTracks[newClip.trackIndex].clips[newClip.clipIndex];
        detectionMethod = "new clip diff across all tracks";
        detectedTrackIndex = newClip.trackIndex;
      }
    }
    if (!trackItem) {
      var mogrtBaseName = basenameNoExt(mogrtPath);
      var byTimeAndName = findClipByTimeAndName(afterSnapshot, playheadTime.seconds, mogrtBaseName, 1.0);
      if (byTimeAndName) {
        trackItem = sequence.videoTracks[byTimeAndName.trackIndex].clips[byTimeAndName.clipIndex];
        detectionMethod = "time+name match";
        detectedTrackIndex = byTimeAndName.trackIndex;
      }
    }
    if (!trackItem) {
      logStep("No inserted clip could be detected on any of the " + videoTrackCount + " video track(s) after checking all three detection tiers.");
      return {
        ok: false,
        requestId: requestId,
        stage: stage,
        error: "importMGT() did not appear to add a clip to any video track (checked all " + videoTrackCount + " track(s)).",
        diagnostics: diagnostics,
        beforeClipCounts: mapClipCounts(beforeSnapshot),
        afterClipCounts: mapClipCounts(afterSnapshot),
      };
    }
    if (detectedTrackIndex === null) {
      detectedTrackIndex = findTrackIndexForClip(sequence, trackItem);
    }
    logStep('Inserted clip: "' + trackItem.name + '" on video track ' + (detectedTrackIndex === null ? "unknown" : detectedTrackIndex) + " via " + detectionMethod + ".");

    // --- Stage: source-text-lookup ---
    stage = STAGE_SOURCE_TEXT_LOOKUP;

    var sourceTextParam = null;
    var componentDisplayName = null;
    try {
      for (var ci = 0; ci < trackItem.components.numItems; ci++) {
        var component = trackItem.components[ci];
        var compName = null;
        try { compName = component.displayName; } catch (eCompName) {}
        for (var pi = 0; pi < component.properties.numItems; pi++) {
          var param = component.properties[pi];
          var pDisplayName = null;
          try { pDisplayName = param.displayName; } catch (ePName) {}
          if (pDisplayName === "Source Text") {
            sourceTextParam = param;
            componentDisplayName = compName;
          }
        }
      }
    } catch (errLocate) {
      logStep("Error while enumerating components/params: " + (errLocate && errLocate.message ? errLocate.message : String(errLocate)));
    }

    var result = {
      trackItemName: trackItem.name,
      detectedTrackIndex: detectedTrackIndex,
      detectionMethod: detectionMethod,
    };

    if (!sourceTextParam) {
      logStep('No "Source Text" param found on the inserted clip\'s components.');
      result.sourceTextFound = false;
      result.diagnostics = diagnostics;
      if (!skipFileSave) {
        stage = STAGE_TEMP_FILE_WRITING;
        result.savedDiagnosticFile = saveDiagnosticJson({ requestId: requestId, result: result }, "caption-studio-source-text-raw-dump.json");
      }
      return { ok: true, requestId: requestId, result: result };
    }

    result.sourceTextFound = true;
    result.componentDisplayName = componentDisplayName;

    var rawValue;
    var getValueThrew = false;
    var getValueError = null;
    var getValueErrorLine = null;
    try {
      rawValue = sourceTextParam.getValue();
    } catch (errGet) {
      getValueThrew = true;
      getValueError = errGet && errGet.message ? errGet.message : String(errGet);
      getValueErrorLine = errGet && typeof errGet.line !== "undefined" ? errGet.line : null;
    }

    if (getValueThrew) {
      logStep("getValue() THREW: " + getValueError + (getValueErrorLine !== null ? " (line " + getValueErrorLine + ")" : ""));
      result.getValueThrew = true;
      result.getValueThrowLocation = "getValue() call on the located Source Text param";
      result.getValueError = getValueError;
      result.getValueErrorLine = getValueErrorLine;
      result.diagnostics = diagnostics;
      if (!skipFileSave) {
        stage = STAGE_TEMP_FILE_WRITING;
        result.savedDiagnosticFile = saveDiagnosticJson({ requestId: requestId, result: result }, "caption-studio-source-text-raw-dump.json");
      }
      return { ok: true, requestId: requestId, result: result };
    }

    var rawType = typeof rawValue;
    result.getValueRawType = rawType;
    logStep("getValue() succeeded. typeof result: " + rawType);

    if (rawType !== "string") {
      logStep("getValue() did not return a string (returned " + rawType + ") -- this diagnostic is specifically for the string-shape anomaly, so byte-level analysis is skipped. See probeSourceTextDeep for a general structural dump of non-string shapes.");
      stage = STAGE_JSON_SERIALIZATION;
      try {
        result.nonStringJsonStringify = JSON.stringify(rawValue);
      } catch (eNs) {
        result.nonStringJsonStringify = "[could not JSON.stringify: " + (eNs.message || eNs) + "]";
      }
      result.diagnostics = diagnostics;
      if (!skipFileSave) {
        stage = STAGE_TEMP_FILE_WRITING;
        result.savedDiagnosticFile = saveDiagnosticJson({ requestId: requestId, result: result }, "caption-studio-source-text-raw-dump.json");
      }
      return { ok: true, requestId: requestId, result: result };
    }

    // --- Stage: raw-string-inspection ---
    stage = STAGE_RAW_STRING_INSPECTION;

    // --- Task 1: exact string length ---
    result.rawStringLength = rawValue.length;
    logStep("Raw string length: " + result.rawStringLength);

    // --- Task 2: JSON.stringify(rawValue) -- reveals hidden/escaped characters ---
    try {
      result.jsonStringifyOfRawValue = JSON.stringify(rawValue);
    } catch (eJs) {
      result.jsonStringifyOfRawValue = "[could not JSON.stringify: " + (eJs.message || eJs) + "]";
    }
    logStep("JSON.stringify(rawValue): " + result.jsonStringifyOfRawValue);

    // --- Task 3: every character code and hex value ---
    result.charCodeDump = charCodeHexDump(rawValue, RAW_BYTES_CHAR_DUMP_CAP);
    result.charCodeDumpTruncated = rawValue.length > RAW_BYTES_CHAR_DUMP_CAP;
    logStep(
      "Character code dump: " + result.charCodeDump.length + " character(s) logged" +
        (result.charCodeDumpTruncated ? " (truncated at " + RAW_BYTES_CHAR_DUMP_CAP + " of " + rawValue.length + ")" : "") + "."
    );

    // --- Task 4: first/last 32 characters separately ---
    result.first32 = rawValue.substring(0, Math.min(32, rawValue.length));
    result.first32CharCodes = charCodeHexDump(result.first32, 32);
    result.last32 = rawValue.length > 32 ? rawValue.substring(rawValue.length - 32) : rawValue;
    result.last32CharCodes = charCodeHexDump(result.last32, 32);
    logStep("First 32 chars: " + JSON.stringify(result.first32) + " | Last 32 chars: " + JSON.stringify(result.last32));

    // --- Detect BOM / null characters (needed for task 6, reported either way) ---
    result.hasUtf8Bom = rawValue.length > 0 && rawValue.charCodeAt(0) === 0xfeff;
    result.hasNullCharacters = rawValue.length !== stripNullChars(rawValue).length;
    logStep("hasUtf8Bom: " + result.hasUtf8Bom + ", hasNullCharacters: " + result.hasNullCharacters);

    // --- Stage: json-serialization (the JSON.parse()/JSON.stringify() normalization attempts) ---
    stage = STAGE_JSON_SERIALIZATION;

    // --- Task 5: JSON.parse(rawValue), exact exception + position on failure ---
    var rawAttempt = tryJsonParse("raw", rawValue);

    // --- Task 6: trimmed / BOM-stripped / null-stripped / fully-normalized ---
    var trimmed;
    try {
      trimmed = rawValue.trim();
    } catch (eTrim) {
      trimmed = rawValue.replace(/^\s+|\s+$/g, "");
      logStep("String.prototype.trim() unavailable/threw (" + (eTrim.message || eTrim) + ") -- used a manual regex trim instead.");
    }
    var trimmedAttempt = tryJsonParse("trimmed", trimmed);

    var noBom = result.hasUtf8Bom ? rawValue.substring(1) : rawValue;
    var noBomAttempt = tryJsonParse("bom-stripped", noBom);

    var noNulls = stripNullChars(rawValue);
    var noNullsAttempt = tryJsonParse("null-stripped", noNulls);

    var fullyNormalized = stripNullChars(noBom).replace(/^\s+|\s+$/g, "");
    var fullyNormalizedAttempt = tryJsonParse("fully-normalized (bom+nulls+trim)", fullyNormalized);

    result.jsonParseAttempts = [rawAttempt, trimmedAttempt, noBomAttempt, noNullsAttempt, fullyNormalizedAttempt];
    result.isValidJsonAfterNormalization = fullyNormalizedAttempt.ok;

    for (var jpi = 0; jpi < result.jsonParseAttempts.length; jpi++) {
      var attempt = result.jsonParseAttempts[jpi];
      logStep(
        'JSON.parse attempt "' + attempt.label + '": ' +
          (attempt.ok
            ? "SUCCEEDED"
            : "FAILED -- " + attempt.error + (attempt.errorPosition !== null ? " (position " + attempt.errorPosition + ")" : "") +
                (attempt.errorLine !== null ? " (line " + attempt.errorLine + ")" : ""))
      );
    }

    // --- Task 7: no setValue() call anywhere in this diagnostic. ---

    result.diagnostics = diagnostics;

    // --- Stage: temp-file-writing ---
    if (skipFileSave) {
      logStep("payload.skipFileSave=true -- temp-file writing skipped, byte-level result still returned in full.");
      result.savedDiagnosticFile = { ok: false, error: "skipped (payload.skipFileSave=true)" };
    } else {
      stage = STAGE_TEMP_FILE_WRITING;
      var saved = saveDiagnosticJson({ requestId: requestId, result: result }, "caption-studio-source-text-raw-dump.json");
      result.savedDiagnosticFile = saved;
      logStep(saved.ok ? "Full diagnostic saved to: " + saved.path : "Could not save diagnostic file: " + saved.error);
    }

    return { ok: true, requestId: requestId, result: result };
  } catch (fatalErr) {
    return buildFatalFailure(requestId, stage, diagnostics, fatalErr);
  }
};

/**
 * Standalone diagnostic (task 8): exercises the exact same byte/JSON
 * helpers inspectSourceTextRawBytes() uses (charCodeHexDump, tryJsonParse,
 * JSON.stringify) against a plain string from `payload.testString` -- NO
 * Premiere host objects (no project/sequence/MOGRT/ComponentParam)
 * touched at all. Purpose: isolate whether an "EvalScript error." is
 * coming from the byte/JSON string-processing logic itself (this command
 * would ALSO fail) versus the Premiere-specific insertion/lookup/file-I/O
 * path (this command would succeed even if the full diagnostic doesn't).
 * Also wrapped in a top-level try/catch with the same stage-tagged
 * failure envelope as inspectSourceTextRawBytes().
 *
 * @param {{testString?: string}} payload
 */
$._captionStudioBridge.testRawBytesHelpers = function (payload, requestId) {
  var diagnostics = [];
  function logStep(message) {
    diagnostics.push(message);
  }
  var stage = STAGE_ARGUMENT_PARSING;

  try {
    // Default deliberately includes a UTF-8 BOM, an embedded null
    // character, and surrounding whitespace around "{}" -- built via
    // String.fromCharCode() rather than string escape literals, per the
    // same escape-handling caution as stripNullChars() above -- and
    // reproduces the exact real-host anomaly this whole diagnostic exists
    // to explain (typeof "string", preview looks like "{}", JSON.parse
    // fails).
    var defaultTestString = String.fromCharCode(0xfeff) + " {}" + String.fromCharCode(0) + "  ";
    var testString = typeof payload.testString === "string" ? payload.testString : defaultTestString;
    logStep("Using test string (length " + testString.length + ").");

    stage = STAGE_RAW_STRING_INSPECTION;
    var result = {
      rawStringLength: testString.length,
      charCodeDump: charCodeHexDump(testString, RAW_BYTES_CHAR_DUMP_CAP),
      first32: testString.substring(0, Math.min(32, testString.length)),
      last32: testString.length > 32 ? testString.substring(testString.length - 32) : testString,
      hasUtf8Bom: testString.length > 0 && testString.charCodeAt(0) === 0xfeff,
      hasNullCharacters: testString.length !== stripNullChars(testString).length,
    };

    stage = STAGE_JSON_SERIALIZATION;
    try {
      result.jsonStringifyOfRawValue = JSON.stringify(testString);
    } catch (eJs) {
      result.jsonStringifyOfRawValue = "[could not JSON.stringify: " + (eJs.message || eJs) + "]";
    }

    var trimmed;
    try {
      trimmed = testString.trim();
    } catch (eTrim) {
      trimmed = testString.replace(/^\s+|\s+$/g, "");
    }
    var noBom = result.hasUtf8Bom ? testString.substring(1) : testString;
    var noNulls = stripNullChars(testString);
    var fullyNormalized = stripNullChars(noBom).replace(/^\s+|\s+$/g, "");

    result.jsonParseAttempts = [
      tryJsonParse("raw", testString),
      tryJsonParse("trimmed", trimmed),
      tryJsonParse("bom-stripped", noBom),
      tryJsonParse("null-stripped", noNulls),
      tryJsonParse("fully-normalized (bom+nulls+trim)", fullyNormalized),
    ];
    result.isValidJsonAfterNormalization = result.jsonParseAttempts[4].ok;

    logStep("Byte/JSON helper self-test completed with no exceptions.");
    result.diagnostics = diagnostics;
    return { ok: true, requestId: requestId, result: result };
  } catch (fatalErr) {
    return buildFatalFailure(requestId, stage, diagnostics, fatalErr);
  }
};

// --- Bisection: find the exact statement that breaks under this host's ExtendScript engine ---
//
// Real-host finding that changes the diagnosis: testRawBytesHelpers()
// touches ZERO Premiere APIs (no app.project, no sequence, no MOGRT, no
// file I/O) and STILL fails with the same non-JSON "EvalScript error." as
// inspectSourceTextRawBytes(). Since a full static audit found none of the
// specifically-named unsupported ES features actually present in the
// source, and since Node's own parser accepts the whole file without
// complaint, the remaining plausible explanation is a genuine
// compile-time fault in one specific statement that only surfaces when
// that code path is actually exercised (older JS engines with deferred/
// lazy per-function compilation can behave exactly like this: the file
// loads and OTHER functions run fine, but a real syntax-level problem
// inside one specific function isn't discovered until that function is
// first invoked — which would also explain why it isn't caught by any
// try/catch, script-level or dispatch()'s own, since it's not a normal
// runtime exception).
//
// This command exists to find that exact statement by bisection, per the
// user's explicit instruction to stop adding diagnostics and instead test
// ONE incremental addition at a time. `payload.step` selects how much
// code runs, in the exact order requested: (0) the bare minimum — return
// a plain object, identical in shape to the already-confirmed-working
// "ping" command; (1) a returned object with one added field; (2) declare
// a short string literal; (3) read .length off it; (4) JSON.stringify()
// it; (5) a charCodeAt() loop (the core of charCodeHexDump()); (6) hex
// conversion + string-padding loop (the rest of charCodeHexDump()'s
// logic, written out inline rather than calling the real function); (7)
// call the REAL charCodeHexDump() helper directly; (8) a bare
// JSON.parse() in try/catch (the core of tryJsonParse()); (9) call the
// REAL tryJsonParse() helper directly; (10) call the REAL
// stripNullChars() helper directly; (11) call the REAL
// testRawBytesHelpers() command function directly — the exact function
// that fails on the live host today. Never touches app/project/sequence
// at any step (task 5). Each step returns immediately — no step runs any
// code beyond what it specifically tests (task 2/4: one addition per
// step, never combined).
$._captionStudioBridge.bisectHostScript = function (payload, requestId) {
  var step = typeof payload.step === "number" ? payload.step : 0;

  try {
    if (step === 0) {
      // Identical shape to "ping" (the simplest command in this file,
      // confirmed working) — if THIS fails, the fault is in
      // dispatch()'s routing to a new command branch, not in any of the
      // string/JSON logic tested by the later steps.
      return { ok: true, requestId: requestId, result: { step: 0, stepName: "minimal object return (same shape as ping)" } };
    }

    if (step === 1) {
      return { ok: true, requestId: requestId, result: { step: 1, stepName: "return plain object with one added field" } };
    }

    if (step === 2) {
      var s2 = "{}";
      return { ok: true, requestId: requestId, result: { step: 2, stepName: 'var s = "{}";', s: s2 } };
    }

    if (step === 3) {
      var s3 = "{}";
      var len3 = s3.length;
      return { ok: true, requestId: requestId, result: { step: 3, stepName: "var len = s.length;", len: len3 } };
    }

    if (step === 4) {
      var s4 = "{}";
      var stringified4 = JSON.stringify(s4);
      return { ok: true, requestId: requestId, result: { step: 4, stepName: "JSON.stringify(s)", stringified: stringified4 } };
    }

    if (step === 5) {
      var s5 = "{}";
      var codes5 = [];
      for (var i5 = 0; i5 < s5.length; i5++) {
        codes5.push(s5.charCodeAt(i5));
      }
      return { ok: true, requestId: requestId, result: { step: 5, stepName: "charCodeAt loop", codes: codes5 } };
    }

    if (step === 6) {
      var s6 = "{}";
      var hexes6 = [];
      for (var i6 = 0; i6 < s6.length; i6++) {
        var code6 = s6.charCodeAt(i6);
        var hex6 = code6.toString(16);
        while (hex6.length < 4) hex6 = "0" + hex6;
        hexes6.push("0x" + hex6);
      }
      return { ok: true, requestId: requestId, result: { step: 6, stepName: "hex conversion + padding loop (inline, not calling charCodeHexDump)", hexes: hexes6 } };
    }

    if (step === 7) {
      var dump7 = charCodeHexDump("{}", 10);
      return { ok: true, requestId: requestId, result: { step: 7, stepName: "call the real charCodeHexDump() helper directly", dump: dump7 } };
    }

    if (step === 8) {
      var ok8 = false;
      var err8 = null;
      try {
        JSON.parse("{}");
        ok8 = true;
      } catch (e8) {
        err8 = e8 && e8.message ? e8.message : String(e8);
      }
      return { ok: true, requestId: requestId, result: { step: 8, stepName: "bare JSON.parse() in try/catch (core of tryJsonParse)", parsedOk: ok8, parseError: err8 } };
    }

    if (step === 9) {
      var attempt9 = tryJsonParse("bisect", "{}");
      return { ok: true, requestId: requestId, result: { step: 9, stepName: "call the real tryJsonParse() helper directly", attempt: attempt9 } };
    }

    if (step === 10) {
      var stripped10 = stripNullChars("a" + String.fromCharCode(0) + "b");
      return { ok: true, requestId: requestId, result: { step: 10, stepName: "call the real stripNullChars() helper directly", stripped: stripped10 } };
    }

    if (step === 11) {
      var innerResult11 = $._captionStudioBridge.testRawBytesHelpers({}, requestId);
      return { ok: true, requestId: requestId, result: { step: 11, stepName: "call the real testRawBytesHelpers() command directly", inner: innerResult11 } };
    }

    return { ok: false, requestId: requestId, error: "Unknown bisect step: " + step + ". Valid steps are 0-11.", stepRequested: step };
  } catch (fatalErr) {
    return buildFatalFailure(requestId, "bisect-step-" + step, [], fatalErr);
  }
};
