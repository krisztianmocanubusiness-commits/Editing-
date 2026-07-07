/**
 * Parse the JSON shape returned by `ppro.Transcript.exportToJSON()` /
 * accepted by `ppro.Transcript.importFromJSON()`.
 *
 * IMPORTANT: Adobe's sample panel (src/transcript.ts) references "the sample
 * Adobe Transcript JSON file spec" but the public sample repo does not ship
 * that spec file, so the exact field names below are inferred from common
 * transcript-export conventions and are defensive about naming variants.
 * Before relying on this in production, export a transcript from a real
 * clip with `Transcript.exportToJSON()` and confirm the field names match;
 * adjust the accessors here if they don't (they're isolated to this file).
 */
export function parseAdobeTranscriptJson(content) {
  const data = typeof content === "string" ? JSON.parse(content) : content;
  const words = [];

  const items =
    data.words ||
    data.items ||
    (Array.isArray(data.segments)
      ? data.segments.flatMap((s) => s.words || [])
      : []) ||
    [];

  for (const w of items) {
    const text = (w.text ?? w.word ?? "").trim();
    if (!text) continue;
    words.push({
      text,
      start: Number(w.start ?? w.startTime ?? w.start_time ?? 0),
      end: Number(w.end ?? w.endTime ?? w.end_time ?? 0),
      confidence: w.confidence,
    });
  }

  return {
    words,
    sourceFormat: "adobe-json",
    hasWordTiming: words.length > 0,
  };
}
