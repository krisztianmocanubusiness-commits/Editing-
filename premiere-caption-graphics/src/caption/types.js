/**
 * @typedef {Object} CaptionChunk
 * @property {string} id
 * @property {number} startSec
 * @property {number} endSec
 * @property {string} text
 * @property {import("../transcript/types.js").TranscriptWord[]} words
 * @property {string[]} keywords     Emphasis word strings (subset of `text`'s tokens).
 * @property {boolean} emphasisOn    Editor's approve/override toggle for this chunk.
 */

import { nextId } from "../util/id.js";

export function makeChunk({ startSec, endSec, words }) {
  return {
    id: nextId("chunk"),
    startSec,
    endSec,
    text: words.map((w) => w.text).join(" "),
    words,
    keywords: [],
    emphasisOn: true,
    included: true,
  };
}
