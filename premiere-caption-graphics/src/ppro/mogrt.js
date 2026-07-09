import { getPpro } from "./client.js";
import { secToTick } from "./time.js";

const MAX_COMPONENT_SCAN = 64;
const MAX_PARAM_SCAN = 64;

/**
 * Insert a .mogrt at a given time on a video track, using the confirmed
 * `SequenceEditor.insertMogrtFromPath` API (see Adobe's sample
 * sequenceEditor.ts: `insertMogrt`). Returns the inserted TrackItem.
 *
 * @param {import("@adobe/premierepro").Project} project
 * @param {import("@adobe/premierepro").Sequence} sequence
 * @param {string} mogrtPath
 * @param {number} startSec
 * @param {number} videoTrackIndex
 */
export async function insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex) {
  const ppro = getPpro();
  const sequenceEditor = ppro.SequenceEditor.getEditor(sequence);
  let mogrtItems = [];
  project.lockedAccess(() => {
    mogrtItems = sequenceEditor.insertMogrtFromPath(
      mogrtPath,
      secToTick(startSec),
      videoTrackIndex,
      videoTrackIndex
    );
  });
  if (!mogrtItems || mogrtItems.length === 0) {
    throw new Error(`insertMogrtFromPath returned no track item for "${mogrtPath}".`);
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
