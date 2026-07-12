import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { resolveAudioTrackIndex } from "../src/ppro/mogrt.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

function noopLog() {}

// --- resolveAudioTrackIndex ---
//
// Regression coverage for the confirmed real-host bug: insertMogrtAt() used
// to pass `videoTrackIndex` for BOTH the video track AND audio track
// arguments to insertMogrtFromPath. That only worked by coincidence (when
// the resolved video track index also happened to be a valid audio track
// index on the active sequence) and threw "Invalid parameter" from
// insertMogrtFromPath as soon as a sequence had more video tracks than
// audio tracks — exactly what the Source Text Round Trip hit, on the same
// .mogrt that had previously inserted fine via Host Smoke Test/Diagnostic
// Inspector earlier in the same session (i.e. before more video tracks had
// accumulated on the active sequence).

test("resolveAudioTrackIndex reuses videoTrackIndex when it's already a valid audio track index", async () => {
  const sequence = { getAudioTrackCount: async () => 2 };
  assert.equal(await resolveAudioTrackIndex(sequence, 0, noopLog), 0);
  assert.equal(await resolveAudioTrackIndex(sequence, 1, noopLog), 1);
});

test("resolveAudioTrackIndex clamps to the last real audio track instead of reusing an out-of-range videoTrackIndex", async () => {
  // The exact reported shape: more video tracks than audio tracks (e.g. 3
  // video tracks, only 1 audio track) — videoTrackIndex resolves to 2 (the
  // topmost video track), which is not a valid audio track index.
  const sequence = { getAudioTrackCount: async () => 1 };
  assert.equal(await resolveAudioTrackIndex(sequence, 2, noopLog), 0);
});

test("resolveAudioTrackIndex logs a warning explaining the clamp when it actually changes the value", async () => {
  const sequence = { getAudioTrackCount: async () => 1 };
  const messages = [];
  await resolveAudioTrackIndex(sequence, 2, (message, level) => messages.push({ message, level }));
  assert.ok(messages.some((m) => m.level === "warn" && /exceeds this sequence's audio track count/.test(m.message)));
});

test("resolveAudioTrackIndex does not log when videoTrackIndex is already in range", async () => {
  const sequence = { getAudioTrackCount: async () => 4 };
  const messages = [];
  await resolveAudioTrackIndex(sequence, 1, (message, level) => messages.push({ message, level }));
  assert.equal(messages.length, 0);
});

test("resolveAudioTrackIndex falls back to 0 (not a crash) when the sequence reports 0 audio tracks", async () => {
  const sequence = { getAudioTrackCount: async () => 0 };
  assert.equal(await resolveAudioTrackIndex(sequence, 2, noopLog), 0);
});

test("resolveAudioTrackIndex falls back to videoTrackIndex (old behavior) when getAudioTrackCount isn't available on this host version", async () => {
  const sequence = {};
  assert.equal(await resolveAudioTrackIndex(sequence, 2, noopLog), 2);
});

test("resolveAudioTrackIndex falls back to videoTrackIndex (not a crash) when getAudioTrackCount throws", async () => {
  const sequence = { getAudioTrackCount: async () => { throw new Error("host error"); } };
  assert.equal(await resolveAudioTrackIndex(sequence, 2, noopLog), 2);
});

test("resolveAudioTrackIndex works with a synchronous (non-Promise) getAudioTrackCount too", async () => {
  const sequence = { getAudioTrackCount: () => 1 };
  assert.equal(await resolveAudioTrackIndex(sequence, 2, noopLog), 0);
});

// --- Regression guard: Source Text Round Trip must call the ONE shared
// insertion helper with the exact same argument shape as the confirmed-
// working Diagnostic Inspector insertion path, not a second, independently
// maintained implementation. ---

test("sourceTextProbe.js's insertMogrtAt call has the exact same argument shape as diagnostics.js's (the confirmed-working Diagnostic Inspector insertion path)", () => {
  const diagnosticsSrc = fs.readFileSync(path.join(ROOT, "src/ppro/diagnostics.js"), "utf8");
  const sourceTextSrc = fs.readFileSync(path.join(ROOT, "src/ppro/sourceTextProbe.js"), "utf8");
  const callPattern = /insertMogrtAt\(project, sequence, mogrtPath, startSec, videoTrackIndex, log\)/;
  assert.match(diagnosticsSrc, callPattern, "diagnostics.js should call insertMogrtAt with (project, sequence, mogrtPath, startSec, videoTrackIndex, log)");
  assert.match(sourceTextSrc, callPattern, "sourceTextProbe.js should call insertMogrtAt with the exact same argument shape as diagnostics.js");
});

test("sourceTextProbe.js and templateInspector.js both import insertMogrtAt from the one shared ./mogrt.js module — no second insertion implementation", () => {
  const files = ["src/ppro/sourceTextProbe.js", "src/ppro/diagnostics.js", "src/ppro/templateInspector.js", "src/ppro/smokeTest.js", "src/ppro/applyCaptions.js"];
  const importPattern = /import\s*\{[^}]*\binsertMogrtAt\b[^}]*\}\s*from\s*["']\.\/mogrt\.js["']/;
  for (const file of files) {
    const src = fs.readFileSync(path.join(ROOT, file), "utf8");
    assert.match(src, importPattern, `${file} should import insertMogrtAt from ./mogrt.js`);
    // None of these files should define their own insertMogrtFromPath call —
    // that host API must only ever be invoked from inside mogrt.js's
    // insertMogrtAt(), the one shared, log-instrumented insertion path.
    assert.doesNotMatch(src, /\.insertMogrtFromPath\(/, `${file} must not call insertMogrtFromPath directly — it must go through insertMogrtAt()`);
  }
});
