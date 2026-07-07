import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkWords, clipChunksToRange, fitWordsToRange, DEFAULT_CHUNK_OPTIONS } from "../src/caption/chunker.js";

function evenWords(text, wordsPerSec = 2) {
  return text.split(" ").map((t, i) => ({
    text: t,
    start: i / wordsPerSec,
    end: (i + 1) / wordsPerSec,
  }));
}

test("chunkWords splits on sentence punctuation", () => {
  const words = evenWords("Hello there. How are you doing today?");
  const chunks = chunkWords(words, DEFAULT_CHUNK_OPTIONS);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks[0].text.endsWith("."));
});

test("chunkWords respects maxWords", () => {
  const words = evenWords("one two three four five six seven eight nine ten", 5);
  const chunks = chunkWords(words, { ...DEFAULT_CHUNK_OPTIONS, maxWords: 3, maxDurationSec: 100, maxChars: 999, pauseGapSec: 100 });
  for (const c of chunks) assert.ok(c.words.length <= 3);
});

test("chunkWords forces a break on a big pause", () => {
  const words = [
    { text: "one", start: 0, end: 0.3 },
    { text: "two", start: 0.3, end: 0.6 },
    { text: "three", start: 3.0, end: 3.3 }, // 2.4s gap
  ];
  const chunks = chunkWords(words, { ...DEFAULT_CHUNK_OPTIONS, pauseGapSec: 0.35, maxDurationSec: 100 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].words.length, 2);
  assert.equal(chunks[1].words.length, 1);
});

test("chunkWords pads chunks shorter than minDurationSec", () => {
  const words = [{ text: "hi", start: 0, end: 0.05 }];
  const chunks = chunkWords(words, { ...DEFAULT_CHUNK_OPTIONS, minDurationSec: 0.6 });
  assert.equal(chunks[0].endSec - chunks[0].startSec, 0.6);
});

test("fitWordsToRange spreads words evenly across a range", () => {
  const words = [{ text: "a" }, { text: "b" }, { text: "c" }, { text: "d" }];
  const fitted = fitWordsToRange(words, 10, 14);
  assert.equal(fitted[0].start, 10);
  assert.equal(fitted[fitted.length - 1].end, 14);
});

test("clipChunksToRange drops chunks fully outside the range and trims overlapping ones", () => {
  const chunks = [
    { id: "a", startSec: 0, endSec: 2, text: "a" },
    { id: "b", startSec: 1.5, endSec: 4, text: "b" },
    { id: "c", startSec: 10, endSec: 12, text: "c" },
  ];
  const clipped = clipChunksToRange(chunks, 1, 5);
  assert.equal(clipped.length, 2);
  assert.equal(clipped[0].startSec, 1);
  assert.equal(clipped[1].endSec, 4);
});
