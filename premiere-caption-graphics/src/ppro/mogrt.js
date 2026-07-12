import { getPpro } from "./client.js";
import { secToTick } from "./time.js";
import { safe } from "./introspect.js";

const MAX_COMPONENT_SCAN = 64;
const MAX_PARAM_SCAN = 64;

/**
 * Resolves a real, in-range audio track index for `insertMogrtFromPath`'s
 * 4th argument. CONFIRMED ROOT CAUSE of an "Invalid parameter" host error
 * from `insertMogrtFromPath` (real host run, Premiere Pro 26.3): the old
 * code blindly passed `videoTrackIndex` for BOTH the video track and audio
 * track arguments. That's only valid by coincidence, when the resolved
 * video track index also happens to be a real audio track index on the
 * active sequence — true for a simple 1-video/1-audio-track sequence, false
 * as soon as a sequence has more video tracks than audio tracks (extremely
 * common — every caller here picks the *topmost* video track index, which
 * climbs with each additional video track regardless of audio track
 * count). Every current caller (Host Smoke Test, Template Inspector,
 * Diagnostic Inspector, the Source Text Round Trip, and the real timeline
 * apply flow) shares this one function, so fixing it here fixes all of
 * them at once — no caller needs to change what it passes in.
 *
 * @param {import("@adobe/premierepro").Sequence} sequence
 * @param {number} videoTrackIndex
 * @param {(message: string, level?: string) => void} [log]
 */
export async function resolveAudioTrackIndex(sequence, videoTrackIndex, log) {
  if (!sequence || typeof sequence.getAudioTrackCount !== "function") {
    if (log) log(`[insertMogrtAt] sequence.getAudioTrackCount() unavailable — falling back to audioTrackIndex=videoTrackIndex (${videoTrackIndex}).`, "warn");
    return videoTrackIndex;
  }
  try {
    const audioTrackCount = await sequence.getAudioTrackCount();
    if (!audioTrackCount || audioTrackCount <= 0) {
      if (log) log(`[insertMogrtAt] sequence reports 0 audio tracks — using audioTrackIndex=0 (best effort).`, "warn");
      return 0;
    }
    const resolved = Math.min(videoTrackIndex, audioTrackCount - 1);
    if (resolved !== videoTrackIndex && log) {
      log(
        `[insertMogrtAt] videoTrackIndex=${videoTrackIndex} exceeds this sequence's audio track count (${audioTrackCount}) — ` +
          `using audioTrackIndex=${resolved} instead of blindly reusing videoTrackIndex (the confirmed cause of "Invalid parameter" ` +
          `from insertMogrtFromPath when a sequence has fewer audio tracks than video tracks).`,
        "warn"
      );
    }
    return resolved;
  } catch (err) {
    if (log) log(`[insertMogrtAt] couldn't read sequence.getAudioTrackCount(): ${err.message || err} — falling back to audioTrackIndex=videoTrackIndex (${videoTrackIndex}).`, "warn");
    return videoTrackIndex;
  }
}

/**
 * Insert a .mogrt at a given time on a video track, using the confirmed
 * `SequenceEditor.insertMogrtFromPath` API (see Adobe's sample
 * sequenceEditor.ts: `insertMogrt`). Returns the inserted TrackItem.
 *
 * The ONE shared insertion path — Host Smoke Test, Template Inspector,
 * Diagnostic Inspector, the Source Text Round Trip, and the real timeline
 * apply flow (applyCaptions.js) all call this exact function; none of them
 * maintain their own separate insertion logic.
 *
 * @param {import("@adobe/premierepro").Project} project
 * @param {import("@adobe/premierepro").Sequence} sequence
 * @param {string} mogrtPath
 * @param {number} startSec
 * @param {number} videoTrackIndex
 * @param {(message: string, level?: string) => void} [log] Optional — when given, every resolved
 *   insertion argument is logged before the host call, and a host error (with its full stack) is
 *   logged before being rethrown to the caller.
 */
export async function insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log) {
  const ppro = getPpro();
  const sequenceEditor = ppro.SequenceEditor.getEditor(sequence);
  const time = secToTick(startSec);
  const audioTrackIndex = await resolveAudioTrackIndex(sequence, videoTrackIndex, log);

  if (log) {
    const sequenceName = safe(() => sequence?.name).value ?? "(name unreadable)";
    log("[insertMogrtAt] resolved insertion arguments:", "info");
    log(`[insertMogrtAt]   path = ${mogrtPath}`, "info");
    log(`[insertMogrtAt]   time = ${startSec}s (TickTime, .seconds=${safe(() => time.seconds).value ?? "?"})`, "info");
    log(`[insertMogrtAt]   videoTrackIndex = ${videoTrackIndex}`, "info");
    log(`[insertMogrtAt]   audioTrackIndex = ${audioTrackIndex}`, "info");
    log(`[insertMogrtAt]   active sequence = "${sequenceName}", sequenceEditor acquired = ${Boolean(sequenceEditor)}`, "info");
  }

  let mogrtItems = [];
  try {
    project.lockedAccess(() => {
      mogrtItems = sequenceEditor.insertMogrtFromPath(mogrtPath, time, videoTrackIndex, audioTrackIndex);
    });
  } catch (err) {
    if (log) log(`[insertMogrtAt] insertMogrtFromPath threw: ${err.message || err}${err.stack ? `\n${err.stack}` : ""}`, "error");
    throw err;
  }

  if (!mogrtItems || mogrtItems.length === 0) {
    const noItemsErr = new Error(`insertMogrtFromPath returned no track item for "${mogrtPath}".`);
    if (log) log(`[insertMogrtAt] ${noItemsErr.message}`, "error");
    throw noItemsErr;
  }
  return mogrtItems[0];
}

/** Trim an inserted track item's end so it matches the caption chunk's duration. */
export function setTrackItemEnd(project, trackItem, endSec, label) {
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(trackItem.createSetEndAction(secToTick(endSec)));
    }, label || "Trim caption graphic");
  });
  return success;
}

/**
 * Walk a track item's component chain looking for an exposed parameter by
 * its Essential Graphics display name.
 *
 * NOTE: Adobe's public sample (keyframe.ts) demonstrates reading a param via
 * a hardcoded `componentChain.getComponentAtIndex(1)` / `component.getParam(1)`
 * for a demo effect, but doesn't show an enumerated "how many components /
 * params exist" call. This walk is defensive: it scans indices until a call
 * throws or returns nothing, bounded by MAX_COMPONENT_SCAN/MAX_PARAM_SCAN so
 * a missing bounds API can't spin forever. If your installed
 * `@adobe/premierepro` type defs expose an explicit count (e.g.
 * `getComponentCount()` / `getParamCount()`), prefer swapping those in here.
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {string} displayName
 */
export async function findExposedParam(trackItem, displayName) {
  const chain = await trackItem.getComponentChain();
  if (!chain) return null;

  for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
    let component;
    try {
      component = chain.getComponentAtIndex(ci);
    } catch {
      break;
    }
    if (!component) break;

    for (let pi = 0; pi < MAX_PARAM_SCAN; pi++) {
      let param;
      try {
        param = component.getParam(pi);
      } catch {
        break;
      }
      if (!param) break;
      if (param.displayName === displayName) {
        return { component, param };
      }
    }
  }
  return null;
}

/**
 * Resolve every requested exposed param on a track item at once, reporting
 * which ones weren't found on this particular .mogrt (so the apply layer
 * can warn instead of silently doing nothing).
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {string[]} displayNames
 */
export async function findExposedParams(trackItem, displayNames) {
  const found = new Map();
  const missing = [];
  for (const name of displayNames) {
    const hit = await findExposedParam(trackItem, name);
    if (hit) found.set(name, hit.param);
    else missing.push(name);
  }
  return { found, missing };
}

/**
 * Remove a track item via ripple delete, following the exact confirmed
 * pattern from Adobe's sample (sequenceEditor.ts `removeSelectedTrackItems`):
 * build a selection containing just this item, then
 * `SequenceEditor.createRemoveItemsAction`. Used by the Template Inspector
 * to clean up the temporary clip it inserts to read a .mogrt's exposed
 * params, so inspecting a template doesn't leave clutter on the timeline.
 *
 * @param {import("@adobe/premierepro").Project} project
 * @param {import("@adobe/premierepro").Sequence} sequence
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 */
export async function removeTrackItem(project, sequence, trackItem) {
  const ppro = getPpro();
  const sequenceEditor = ppro.SequenceEditor.getEditor(sequence);
  const selection = await sequence.getSelection();
  selection.addItem(trackItem, false);

  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      const removeAction = sequenceEditor.createRemoveItemsAction(selection, true, ppro.Constants.MediaType.VIDEO);
      compoundAction.addAction(removeAction);
    }, "Remove temporary inspection clip");
  });
  return success;
}
