/**
 * @typedef {Object} TranscriptWord
 * @property {string} text
 * @property {number} start  seconds
 * @property {number} end    seconds
 * @property {number} [confidence]
 */

/**
 * @typedef {Object} Transcript
 * @property {TranscriptWord[]} words   Flat word list, sorted by start time.
 * @property {string} sourceFormat      "srt" | "vtt" | "text" | "whisper-json" | "adobe-json"
 * @property {boolean} hasWordTiming    True if word-level timestamps are real (not estimated).
 */

/** Build an empty transcript. */
export function emptyTranscript(sourceFormat = "text") {
  return { words: [], sourceFormat, hasWordTiming: false };
}

/**
 * Turn timed lines (start/end/text but no per-word timing, e.g. SRT cues) into
 * a word list by evenly distributing each cue's duration across its words.
 * This is a deliberate approximation flagged via hasWordTiming = false so
 * downstream chunking knows the per-word boundaries are estimated.
 */
export function wordsFromTimedLines(lines) {
  const words = [];
  for (const line of lines) {
    const tokens = line.text.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const duration = Math.max(line.end - line.start, 0.001);
    const perWord = duration / tokens.length;
    tokens.forEach((token, i) => {
      words.push({
        text: token,
        start: line.start + i * perWord,
        end: line.start + (i + 1) * perWord,
      });
    });
  }
  return words;
}
