// Lightweight, dependency-free keyword/emphasis scoring. No ML model or
// network call is available inside the panel sandbox, so this is a
// transparent heuristic the editor can see and override per chunk in the UI
// rather than an opaque "AI" black box.

const STOPWORDS = new Set(
  (
    "a an the and or but if then so because as of in on at by for with " +
    "about against between into through during before after above below " +
    "to from up down out off over under again further once here there " +
    "when where why how all any both each few more most other some such " +
    "no nor not only own same than too very s t can will just don should " +
    "now i me my myself we our ours you your yours he him his she her it " +
    "its they them their this that these those am is are was were be " +
    "been being have has had having do does did doing would could ought " +
    "im youre hes shes its were theyre ive youve weve theyve id youd hed " +
    "wed theyd ill youll hell well theyll isnt arent wasnt werent hasnt " +
    "havent hadnt doesnt dont didnt wont wouldnt shant shouldnt cant " +
    "couldnt mustnt lets whats"
  ).split(" ")
);

// Words that short-form/marketing captions conventionally punch up.
const POWER_WORDS = new Set(
  (
    "now free new win secret never always best first you must stop " +
    "warning huge insane proven exclusive instantly guaranteed shocking " +
    "truth mistake danger easy fast breaking urgent limited today finally"
  ).split(" ")
);

function normalize(token) {
  return token.toLowerCase().replace(/[^a-z0-9%$'-]/g, "");
}

/**
 * Score every word in a chunk's word list. Higher = stronger emphasis
 * candidate. Pure function, no state, so it's covered by the unit tests.
 *
 * @param {import("../transcript/types.js").TranscriptWord[]} words
 * @returns {{ word: import("../transcript/types.js").TranscriptWord, score: number }[]}
 */
export function scoreWords(words) {
  return words.map((word, i) => {
    const raw = word.text;
    const norm = normalize(raw);
    let score = 0;

    if (!norm || STOPWORDS.has(norm)) {
      return { word, score: -1 };
    }

    if (norm.length >= 4) score += 1;
    if (norm.length >= 7) score += 1;
    if (/^\d/.test(norm) || /%|\$/.test(raw)) score += 2;
    if (POWER_WORDS.has(norm)) score += 3;
    if (/^[A-Z]{2,}$/.test(raw)) score += 2; // ALL CAPS
    if (/^[A-Z]/.test(raw) && i > 0) score += 1; // mid-sentence capital = proper noun-ish
    if (/[!?]$/.test(raw)) score += 1; // punctuation-adjacent

    return { word, score };
  });
}

/**
 * Pick the top-N emphasis words for a chunk (default 2), ignoring anything
 * scored below the stopword floor.
 *
 * @param {import("../transcript/types.js").TranscriptWord[]} words
 * @param {{ maxKeywords?: number, minScore?: number }} [opts]
 * @returns {string[]}
 */
export function pickEmphasisWords(words, opts = {}) {
  const { maxKeywords = 2, minScore = 2 } = opts;
  const scored = scoreWords(words).filter((s) => s.score >= minScore);
  scored.sort((a, b) => b.score - a.score);
  const seen = new Set();
  const picked = [];
  for (const { word } of scored) {
    const key = normalize(word.text);
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(word.text);
    if (picked.length >= maxKeywords) break;
  }
  return picked;
}
