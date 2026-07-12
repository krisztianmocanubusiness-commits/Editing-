import { getPpro } from "./client.js";
import { tickToSec, secToTick } from "./time.js";
import { safeAsync } from "./introspect.js";

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

// Generous upper bound (7 days) — real timelines never legitimately run
// this long, so anything beyond it is treated the same as a negative value:
// almost certainly a sentinel/invalid TickTime, not a real position.
export const MAX_SANE_TIMELINE_SECONDS = 24 * 60 * 60 * 7;

/**
 * A TickTime-derived seconds value is only trustworthy as a real timeline
 * position if it's a finite, non-negative number within a sane bound.
 *
 * CONFIRMED REAL-HOST BUG this guards against: `sequence.getInPoint()`
 * (or `getOutPoint()`) can return a TickTime representing "no in/out point
 * set" as a huge sentinel value instead of 0 or throwing — observed on a
 * real host run resolving to exactly `-400000` seconds (ticks =
 * `-101606400000000000`, i.e. `-400000 * 254016000000` — Premiere's
 * documented 254016000000-ticks-per-second resolution — strongly
 * suggesting a deliberately-chosen internal sentinel tick count, not
 * arithmetic noise). The old code only checked `outSec > inSec`, which a
 * pair of sentinels (or one sentinel and one real value) can still satisfy
 * by pure coincidence, silently poisoning every downstream calculation —
 * including, on that run, where a temporary diagnostic MOGRT got inserted
 * (`-400000.000s`). See docs/MOGRT_DIAGNOSTIC.md.
 */
export function isValidTimelineSeconds(sec) {
  return Number.isFinite(sec) && sec >= 0 && sec <= MAX_SANE_TIMELINE_SECONDS;
}

/**
 * Read the editor's selected timeline range. Prefers the sequence's work
 * in/out points (getInPoint/getOutPoint, mirrored by the confirmed
 * createSetInPointAction/createSetOutPointAction pair in Adobe's sample).
 * Falls back to the full sequence duration if in/out aren't set, since not
 * every Premiere Pro build exposes in/out getters identically. Every
 * TickTime-derived value is validated via `isValidTimelineSeconds()`
 * before being trusted — an invalid/sentinel value is never returned, no
 * matter which source it came from; the return value is always a real,
 * non-negative, sane timeline position.
 *
 * @param {import("@adobe/premierepro").Sequence} sequence
 */
export async function getSelectedRangeSeconds(sequence) {
  const end = await sequence.getEndTime();
  const endTickSec = tickToSec(end);
  let startSec = 0;
  let endSec = isValidTimelineSeconds(endTickSec) ? endTickSec : 0;

  try {
    if (typeof sequence.getInPoint === "function" && typeof sequence.getOutPoint === "function") {
      const inPoint = await sequence.getInPoint();
      const outPoint = await sequence.getOutPoint();
      const inSec = tickToSec(inPoint);
      const outSec = tickToSec(outPoint);
      // A zero-length or unset in/out range collapses to 0..0; treat that
      // as "no selection". Both values must ALSO be individually sane —
      // never trust a negative or absurdly large "unset" sentinel just
      // because it happens to compare as outSec > inSec.
      if (isValidTimelineSeconds(inSec) && isValidTimelineSeconds(outSec) && outSec > inSec) {
        startSec = inSec;
        endSec = outSec;
      }
    }
  } catch {
    // getInPoint/getOutPoint aren't guaranteed on every host version; fall back silently.
  }

  return { startSec, endSec };
}

// Adobe's public sample panel does not demonstrate a CTI/playhead getter
// on Sequence, so this tries a few plausible method names — see
// resolveInsertionTimeSec()'s doc comment.
const PLAYHEAD_CANDIDATE_METHODS = ["getPlayerPosition", "getPlayheadPosition", "getCurrentTime"];

/**
 * Resolves ONE safe, valid timeline position to insert at, in priority
 * order: (1) the current playhead position, tried via a few plausible
 * getter names, if one exists and returns a valid/sane value; (2) the
 * sequence's in-point, via `getSelectedRangeSeconds()`, if valid; (3) 0
 * seconds. Every candidate — regardless of source — is validated via
 * `isValidTimelineSeconds()` before being trusted, so an invalid/sentinel
 * TickTime (see that function's doc comment) can never reach a MOGRT
 * insertion call, no matter which of the three sources it came from. This
 * is the ONE shared insertion-time resolver — every diagnostic/apply path
 * in this extension that needs "where should this clip go?" calls this,
 * rather than each independently reimplementing (and potentially
 * diverging on) the same fallback chain.
 *
 * @param {import("@adobe/premierepro").Sequence} sequence
 * @param {(message: string, level?: string) => void} [log]
 * @returns {Promise<number>}
 */
export async function resolveInsertionTimeSec(sequence, log) {
  for (const name of PLAYHEAD_CANDIDATE_METHODS) {
    if (typeof sequence[name] !== "function") continue;
    // eslint-disable-next-line no-await-in-loop
    const result = await safeAsync(() => sequence[name]());
    if (result.ok) {
      const sec = tickToSec(result.value);
      if (isValidTimelineSeconds(sec)) {
        if (log) log(`Insertion time resolved via sequence.${name}() (current playhead) → ${sec.toFixed(3)}s`, "success");
        return sec;
      }
      if (log) {
        log(`sequence.${name}() returned an invalid/out-of-range time (${sec}s, likely an "unset" sentinel) — ignoring, trying the next source.`, "warn");
      }
    } else if (log) {
      log(`sequence.${name}() exists but threw: ${result.error.message || result.error}`, "warn");
    }
  }

  const rangeResult = await safeAsync(() => getSelectedRangeSeconds(sequence));
  if (rangeResult.ok) {
    // getSelectedRangeSeconds() always returns an already-validated,
    // non-negative, sane startSec (0 by default) — safe to return as-is.
    if (rangeResult.value.startSec > 0 && log) {
      log(`Insertion time resolved via sequence in-point → ${rangeResult.value.startSec.toFixed(3)}s`, "success");
    }
    return rangeResult.value.startSec;
  }
  if (log) log(`getSelectedRangeSeconds() threw while resolving insertion time: ${rangeResult.error.message || rangeResult.error}`, "warn");

  if (log) log("No valid playhead or in-point found — falling back to 0.000s.", "info");
  return 0;
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
