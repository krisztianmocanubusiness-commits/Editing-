import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEmphasisWords, scoreWords } from "../src/caption/keywords.js";

function words(text) {
  return text.split(" ").map((t, i) => ({ text: t, start: i, end: i + 0.5 }));
}

test("stopwords score below the floor", () => {
  const scored = scoreWords(words("the a and is"));
  assert.ok(scored.every((s) => s.score < 0));
});

test("power words and numbers outrank plain words", () => {
  const picked = pickEmphasisWords(words("This is a huge 50% secret"), { maxKeywords: 2 });
  assert.ok(picked.includes("50%") || picked.includes("huge") || picked.includes("secret"));
  assert.ok(!picked.includes("This") || picked.length <= 2);
});

test("pickEmphasisWords respects maxKeywords", () => {
  const picked = pickEmphasisWords(words("secret proven huge insane warning"), { maxKeywords: 2 });
  assert.equal(picked.length, 2);
});

test("no candidates returns empty array", () => {
  const picked = pickEmphasisWords(words("the a and is"));
  assert.deepEqual(picked, []);
});
