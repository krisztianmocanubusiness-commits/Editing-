import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSrt } from "../src/transcript/parseSrt.js";
import { parseVtt } from "../src/transcript/parseVtt.js";
import { parseWhisperJson } from "../src/transcript/parseWhisperJson.js";
import { parsePlainText } from "../src/transcript/parsePlainText.js";
import { parseTranscript } from "../src/transcript/index.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("parseSrt reads cues and strips tags", () => {
  const srt = fs.readFileSync(path.join(__dirname, "../sample-data/sample-transcript.srt"), "utf8");
  const transcript = parseSrt(srt);
  assert.equal(transcript.sourceFormat, "srt");
  assert.ok(transcript.words.length > 10);
  assert.equal(transcript.words[0].text, "This");
  assert.ok(transcript.words[0].start === 0);
});

test("parseVtt handles WEBVTT header and HH:MM:SS.mmm timestamps", () => {
  const vtt = "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n";
  const transcript = parseVtt(vtt);
  assert.equal(transcript.words.length, 2);
  assert.equal(transcript.words[0].text, "Hello");
});

test("parseWhisperJson extracts word-level timing from segments", () => {
  const raw = fs.readFileSync(path.join(__dirname, "../sample-data/sample-transcript-whisper.json"), "utf8");
  const transcript = parseWhisperJson(raw);
  assert.equal(transcript.hasWordTiming, true);
  assert.ok(transcript.words.length >= 15);
  assert.equal(transcript.words[0].text, "This");
  assert.ok(transcript.words[0].end > transcript.words[0].start);
});

test("parsePlainText tokenizes without timing", () => {
  const transcript = parsePlainText("Hello   world\nfoo bar");
  assert.deepEqual(transcript.words.map((w) => w.text), ["Hello", "world", "foo", "bar"]);
  assert.equal(transcript.hasWordTiming, false);
});

test("parseTranscript auto-detects format by extension", () => {
  const srt = fs.readFileSync(path.join(__dirname, "../sample-data/sample-transcript.srt"), "utf8");
  assert.equal(parseTranscript(srt, "clip.srt").sourceFormat, "srt");
  assert.equal(parseTranscript("just some words", "script.txt").sourceFormat, "text");
});
