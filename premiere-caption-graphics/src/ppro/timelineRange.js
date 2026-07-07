import { getPpro } from "./client.js";
import { tickToSec, secToTick } from "./time.js";

/**
 * Resolve the active project + sequence, throwing a clear panel-friendly
 * error if either is missing (no project open / no sequence open).
 */
export async function requireActiveProjectAndSequence() {
  const ppro = getPpro();
  const project = await ppro.Project.getActiveProject();
  if (!project) throw new Error("No active Premiere project. Open a project first.");
  const sequence = await project.getActiveSequence();
  if (!sequence) throw new Error("No active sequence. Open a sequence first.");
  return { project, sequence };
}

/**
 * Read the editor's selected timeline range. Prefers the sequence's work
 * in/out points (getInPoint/getOutPoint, mirrored by the confirmed
 * createSetInPointAction/createSetOutPointAction pair in Adobe's sample).
 * Falls back to the full sequence duration if in/out aren't set, since not
 * every Premiere Pro build exposes in/out getters identically.
 *
 * @param {import("@adobe/premierepro").Sequence} sequence
 */
export async function getSelectedRangeSeconds(sequence) {
  const end = await sequence.getEndTime();
  let startSec = 0;
  let endSec = tickToSec(end);

  try {
    if (typeof sequence.getInPoint === "function" && typeof sequence.getOutPoint === "function") {
      const inPoint = await sequence.getInPoint();
      const outPoint = await sequence.getOutPoint();
      const inSec = tickToSec(inPoint);
      const outSec = tickToSec(outPoint);
      // A zero-length or unset in/out range collapses to 0..0; treat that as "no selection".
      if (outSec > inSec) {
        startSec = inSec;
        endSec = outSec;
      }
    }
  } catch {
    // getInPoint/getOutPoint aren't guaranteed on every host version; fall back silently.
  }

  return { startSec, endSec };
}

/**
 * Set the sequence's in/out points to a given range, using the confirmed
 * createSetInPointAction / createSetOutPointAction transaction pattern.
 */
export async function setSequenceRangeSeconds(project, sequence, startSec, endSec) {
  let success = false;
  project.lockedAccess(() => {
    success = project.executeTransaction((compoundAction) => {
      compoundAction.addAction(sequence.createSetInPointAction(secToTick(startSec)));
      compoundAction.addAction(sequence.createSetOutPointAction(secToTick(endSec)));
    }, "Set Caption Studio timeline range");
  });
  return success;
}

/**
 * List video tracks with their index + name, for the "target track" picker.
 * Track *creation* isn't part of the confirmed scripting surface this
 * extension is built on, so the panel asks the editor to pick an existing
 * (ideally empty) video track above their footage rather than trying to
 * add one programmatically.
 */
export async function listVideoTracks(sequence) {
  const ppro = getPpro();
  const count = await sequence.getVideoTrackCount();
  const tracks = [];
  for (let i = 0; i < count; i++) {
    const track = await sequence.getVideoTrack(i);
    tracks.push({ index: i, name: track?.name ?? `V${i + 1}` });
  }
  return tracks;
}
