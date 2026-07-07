import { getPpro } from "./client.js";
import { tickToSec } from "./time.js";
import { parseAdobeTranscriptJson } from "../transcript/parseAdobeTranscriptJson.js";

/**
 * Best-effort read of a track item's timeline start position in seconds.
 * Adobe's public sample confirms `getEndTime()` / `createSetEndAction()`
 * and `getInPoint()` / `getOutPoint()` (media-relative) on clip track items,
 * but does not show the counterpart "getStart()" getter. We try the two
 * plausible names and fail loudly rather than silently mis-placing captions
 * if neither exists on the installed host version.
 */
async function getTrackItemTimelineStartSec(trackItem) {
  if (typeof trackItem.getStartTime === "function") {
    return tickToSec(await trackItem.getStartTime());
  }
  if (typeof trackItem.getStart === "function") {
    return tickToSec(await trackItem.getStart());
  }
  throw new Error(
    "Couldn't find a timeline-start getter on this track item (tried getStartTime/getStart). " +
      "Check the @adobe/premierepro type declarations in your environment and update " +
      "getTrackItemTimelineStartSec() in src/ppro/transcriptBridge.js accordingly."
  );
}

/**
 * Does the given (selected) project item already have a transcript attached?
 */
export async function selectedClipHasTranscript(clipProjectItem) {
  const ppro = getPpro();
  return ppro.Transcript.hasTranscript(clipProjectItem);
}

/**
 * Pull a clip's attached transcript and remap its (media-relative) word
 * timestamps into sequence time, using the selected track item's timeline
 * position + in-point as the offset. This lets an editor generate captions
 * from a clip's built-in Premiere transcript instead of importing a file.
 *
 * @param {import("@adobe/premierepro").ClipProjectItem} clipProjectItem
 * @param {import("@adobe/premierepro").VideoClipTrackItem} trackItem
 */
export async function transcriptFromClip(clipProjectItem, trackItem) {
  const ppro = getPpro();
  const json = await ppro.Transcript.exportToJSON(clipProjectItem);
  const parsed = parseAdobeTranscriptJson(json);

  const timelineStartSec = await getTrackItemTimelineStartSec(trackItem);
  const mediaInPointSec = tickToSec(await trackItem.getInPoint());
  const offset = timelineStartSec - mediaInPointSec;

  const words = parsed.words.map((w) => ({
    ...w,
    start: w.start + offset,
    end: w.end + offset,
  }));

  return { words, sourceFormat: "adobe-json", hasWordTiming: parsed.hasWordTiming };
}
