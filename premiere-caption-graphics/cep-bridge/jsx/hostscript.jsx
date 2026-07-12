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

/**
 * The proof of concept itself: import the given .mogrt at the playhead,
 * set its duration to `durationSec`, locate its "Source Text" param by
 * displayName (never a fixed index — same discipline the UXP diagnostics
 * use, see docs/MOGRT_DIAGNOSTIC.md), and attempt
 * ComponentParam.setValue(sentinel, true) — the direct ExtendScript
 * equivalent of the UXP call (createSetValueAction) that threw "Illegal
 * Parameter type". Every step's outcome is recorded independently so a
 * failure partway through still returns a full, honest report of what did
 * and didn't work, exactly like every UXP diagnostic in this project.
 *
 * @param {{mogrtPath: string, text?: string, durationSec?: number, videoTrackIndex?: number}} payload
 */
$._captionStudioBridge.createTextGraphic = function (payload, requestId) {
  var mogrtPath = payload.mogrtPath;
  var sentinelText = payload.text || "__KERIS_CEP_TEST__";
  var durationSec = typeof payload.durationSec === "number" ? payload.durationSec : 2;
  var videoTrackIndex = typeof payload.videoTrackIndex === "number" ? payload.videoTrackIndex : 0;

  if (!mogrtPath) {
    return { ok: false, requestId: requestId, error: "payload.mogrtPath is required." };
  }

  var project = app.project;
  if (!project) {
    return { ok: false, requestId: requestId, error: "No active Premiere project. Open a project first." };
  }
  var sequence = project.activeSequence;
  if (!sequence) {
    return { ok: false, requestId: requestId, error: "No active sequence. Open a sequence first." };
  }
  if (videoTrackIndex < 0 || videoTrackIndex >= sequence.videoTracks.numTracks) {
    return {
      ok: false,
      requestId: requestId,
      error: "videoTrackIndex " + videoTrackIndex + " is out of range (sequence has " + sequence.videoTracks.numTracks + " video track(s)).",
    };
  }

  var playheadTime;
  try {
    playheadTime = sequence.getPlayerPosition();
  } catch (err) {
    return { ok: false, requestId: requestId, error: "sequence.getPlayerPosition() threw: " + (err && err.message ? err.message : String(err)) };
  }

  var track = sequence.videoTracks[videoTrackIndex];
  var beforeCount = track.clips.numItems;

  // Sequence.importMGT(path, timeInTicks, videoTrackIndex, audioTrackIndex)
  // — documented `time` argument is a String, in ticks (distinct from
  // Sequence.insertClip's plain-seconds `time`; see the API table in
  // docs/CEP_BRIDGE_INVESTIGATION.md Part 3), hence reading `.ticks` off
  // the Time object rather than passing seconds directly.
  try {
    sequence.importMGT(mogrtPath, playheadTime.ticks, videoTrackIndex, videoTrackIndex);
  } catch (err) {
    return {
      ok: false,
      requestId: requestId,
      error: "sequence.importMGT() threw: " + (err && err.message ? err.message : String(err)),
      stack: err && err.stack ? String(err.stack) : null,
    };
  }

  // importMGT's return value isn't consistently documented across host
  // versions, so the inserted clip is reacquired defensively: find the
  // clip on this track whose start lands at (or very near) the playhead,
  // falling back to "the newest clip on the track" if that search comes
  // up empty — never assume a specific index/return shape.
  var afterCount = track.clips.numItems;
  if (afterCount <= beforeCount) {
    return {
      ok: false,
      requestId: requestId,
      error: "importMGT() did not appear to add a clip to video track " + videoTrackIndex + " (clip count unchanged: " + beforeCount + ").",
    };
  }

  var trackItem = null;
  for (var i = 0; i < track.clips.numItems; i++) {
    var candidate = track.clips[i];
    try {
      if (Math.abs(candidate.start.seconds - playheadTime.seconds) < 0.5) {
        trackItem = candidate;
        break;
      }
    } catch (err) {
      // Some clip types may not expose .start cleanly; skip and keep looking.
    }
  }
  if (!trackItem) {
    trackItem = track.clips[track.clips.numItems - 1];
  }

  var result = {
    trackItemName: trackItem.name,
    start: trackItem.start.seconds,
    originalEnd: trackItem.end.seconds,
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

  // THE test this whole proof of concept exists for: does
  // ComponentParam.setValue() accept a raw string where UXP's
  // createSetValueAction() threw "Illegal Parameter type"?
  try {
    sourceTextParam.setValue(sentinelText, true);
    result.sourceTextWriteOk = true;
  } catch (err) {
    result.sourceTextWriteOk = false;
    result.sourceTextWriteError = err && err.message ? err.message : String(err);
  }

  // Best-effort read-back — same caveat as every UXP read-back check in
  // this project: informative, not authoritative proof either way.
  try {
    result.sourceTextReadBack = sourceTextParam.getValue();
  } catch (err) {
    result.sourceTextReadBackError = err && err.message ? err.message : String(err);
  }

  return { ok: true, requestId: requestId, result: result };
};
