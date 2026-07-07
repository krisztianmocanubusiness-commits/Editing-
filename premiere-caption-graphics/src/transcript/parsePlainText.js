/**
 * Parse untimed plain text into a Transcript by synthesizing word timing from
 * an assumed speaking rate. Used when the editor pastes a script with no
 * timestamps at all; the chunker still needs *some* time axis to place
 * graphics against the selected timeline range, so we spread words evenly
 * across that range at apply-time instead (see chunker.js `fitToRange`).
 * Here we just tokenize and mark hasWordTiming = false with start/end = 0,
 * leaving real placement to the chunker's range-fitting pass.
 */
export function parsePlainText(content) {
  const tokens = content
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

  const words = tokens.map((text) => ({ text, start: 0, end: 0 }));

  return {
    words,
    sourceFormat: "text",
    hasWordTiming: false,
  };
}
