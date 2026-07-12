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
        result: { pong: true, appVersion: (app && app.version) || null, hasActiveSequence: Boolean(app && app.project && app.project.activeSequence) },
      };
    } else if (command === "createTextGraphic") {
      response = $._captionStudioBridge.createTextGraphic(payload, requestId);
    } else {
      response = { ok: false, requestId: requestId, error: "Unknown command: " + command };
    }
    return JSON.stringify(response);
  } catch (err) {
    return JSON.stringify({
      ok: false,
      requestId: requestId,
      error: "dispatch() threw: " + (err && err.message ? err.message : String(err)),
      stack: err && err.stack ? String(err.stack) : null,
    });
  }
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
