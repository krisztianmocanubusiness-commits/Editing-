import { makeChunk } from "./types.js";
import { pickEmphasisWords } from "./keywords.js";

/**
 * @typedef {Object} ChunkOptions
 * @property {number} maxChars        Soft cap on characters per chunk (default 32, good for 9:16 captions).
 * @property {number} maxWords        Hard cap on words per chunk (default 7).
 * @property {number} maxDurationSec  Never let one chunk sit on screen longer than this (default 3.2s).
 * @property {number} minDurationSec  Pad short chunks up to at least this long (default 0.6s).
 * @property {number} pauseGapSec     A gap this long between words forces a chunk break (default 0.35s).
 * @property {number} maxKeywords     Emphasis words to tag per chunk (default 2).
 */

/** @type {ChunkOptions} */
export const DEFAULT_CHUNK_OPTIONS = {
  maxChars: 32,
  maxWords: 7,
  maxDurationSec: 3.2,
  minDurationSec: 0.6,
  pauseGapSec: 0.35,
  maxKeywords: 2,
};

const SENTENCE_END_RE = /[.!?…]$/;

/**
 * Words with no real timing (plain-text paste) get a synthetic time axis by
 * spreading them evenly across the given range at a fixed speaking rate.
 *
 * @param {import("../transcript/types.js").TranscriptWord[]} words
 * @param {number} rangeStartSec
 * @param {number} rangeEndSec
 */
export function fitWordsToRange(words, rangeStartSec, rangeEndSec) {
  if (words.length === 0) return [];
  const span = Math.max(rangeEndSec - rangeStartSec, 0.001);
  const per = span / words.length;
  return words.map((w, i) => ({
    ...w,
    start: rangeStartSec + i * per,
    end: rangeStartSec + (i + 1) * per,
  }));
}

/**
 * Split a word list into timed CaptionChunks.
 *
 * @param {import("../transcript/types.js").TranscriptWord[]} words
 * @param {Partial<ChunkOptions>} [options]
 * @returns {import("./types.js").CaptionChunk[]}
 */
export function chunkWords(words, options = {}) {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  const chunks = [];
  let current = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const startSec = current[0].start;
    let endSec = current[current.length - 1].end;
    if (endSec - startSec < opts.minDurationSec) {
      endSec = startSec + opts.minDurationSec;
    }
    const chunk = makeChunk({ startSec, endSec, words: current });
    chunk.keywords = pickEmphasisWords(current, { maxKeywords: opts.maxKeywords });
    chunks.push(chunk);
    current = [];
    currentChars = 0;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const prev = words[i - 1];
    const gap = prev ? word.start - prev.end : 0;

    const wouldExceedChars = currentChars + word.text.length + 1 > opts.maxChars;
    const wouldExceedWords = current.length + 1 > opts.maxWords;
    const wouldExceedDuration =
      current.length > 0 && word.end - current[0].start > opts.maxDurationSec;
    const bigPause = current.length > 0 && gap >= opts.pauseGapSec;

    if (current.length > 0 && (wouldExceedChars || wouldExceedWords || wouldExceedDuration || bigPause)) {
      flush();
    }

    current.push(word);
    currentChars += word.text.length + 1;

    const endsSentence = SENTENCE_END_RE.test(word.text);
    if (endsSentence) flush();
  }
  flush();

  return chunks;
}

/**
 * Keep only chunks that overlap [rangeStartSec, rangeEndSec], clipping their
 * boundaries (and word lists) to stay inside the range. Used to constrain
 * caption generation to the editor's selected timeline range.
 *
 * @param {import("./types.js").CaptionChunk[]} chunks
 */
export function clipChunksToRange(chunks, rangeStartSec, rangeEndSec) {
  const out = [];
  for (const chunk of chunks) {
    if (chunk.endSec <= rangeStartSec || chunk.startSec >= rangeEndSec) continue;
    const startSec = Math.max(chunk.startSec, rangeStartSec);
    const endSec = Math.min(chunk.endSec, rangeEndSec);
    if (endSec - startSec <= 0.01) continue;
    out.push({ ...chunk, startSec, endSec });
  }
  return out;
}
