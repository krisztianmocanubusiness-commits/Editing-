import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const HOSTSCRIPT_PATH = path.join(ROOT, "cep-bridge", "jsx", "hostscript.jsx");

// hostscript.jsx runs inside Premiere's ExtendScript engine (globals like
// app/Time don't exist under Node), so — same as this project's other
// host-only files — these are static source-text regression checks, not
// execution tests. See test/entrypoint.test.js and test/mogrt.test.js for
// the same pattern used elsewhere in this codebase.
//
// CONFIRMED REAL-HOST BUG this file guards against: createTextGraphic()
// used to hard-code videoTrackIndex to 0 whenever the caller didn't pass
// one, and only ever checked that one track's clip count to decide whether
// importMGT() inserted a clip. On a sequence with 13+ video tracks, the
// clip almost certainly landed elsewhere, so the old code reported
// "did not appear to add a clip to video track 0" even when insertion had
// actually succeeded — it just never looked anywhere else. These checks
// make sure that specific failure mode can't silently come back.

function readHostScript() {
  return fs.readFileSync(HOSTSCRIPT_PATH, "utf8");
}

test("hostscript.jsx exists and is non-trivial", () => {
  const source = readHostScript();
  assert.ok(source.length > 500, "expected a real, non-empty hostscript.jsx");
});

test("createTextGraphic never hard-codes videoTrackIndex to a literal 0 fallback", () => {
  const source = readHostScript();
  // The exact regressed pattern: `... : 0;` as the fallback for an
  // unset/invalid requested video track index. The fixed version falls
  // back to the topmost track (videoTrackCount - 1) instead.
  assert.doesNotMatch(
    source,
    /requestedVideoTrackIndex\s*:\s*0\s*;/,
    "found a hard-coded `: 0` fallback for videoTrackIndex — must fall back to the topmost video track instead"
  );
  assert.doesNotMatch(
    source,
    /var\s+videoTrackIndex\s*=\s*typeof\s+payload\.videoTrackIndex\s*===\s*["']number["']\s*\?\s*payload\.videoTrackIndex\s*:\s*0\s*;/,
    "found the original regressed pattern: videoTrackIndex hard-coded to 0 whenever payload.videoTrackIndex is absent"
  );
});

test("createTextGraphic falls back to the topmost video track (videoTrackCount - 1), matching the UXP insertion convention", () => {
  const source = readHostScript();
  assert.match(
    source,
    /videoTrackCount\s*-\s*1/,
    "expected a topmost-video-track fallback expression (videoTrackCount - 1) somewhere in hostscript.jsx"
  );
});

test("clip detection snapshots every video track (scans sequence.videoTracks.numTracks), not a single fixed index", () => {
  const source = readHostScript();
  assert.match(
    source,
    /function\s+snapshotAllVideoTracks\s*\(/,
    "expected a snapshotAllVideoTracks() helper that reads every video track, not one hard-coded index"
  );
  assert.match(
    source,
    /sequence\.videoTracks\.numTracks/,
    "expected the snapshot helper to iterate up to sequence.videoTracks.numTracks"
  );
});

test("clip detection is a three-tier cascade — importMGT's return value, then a full before/after diff, then time+name match — never just track 0's clip count", () => {
  const source = readHostScript();
  assert.match(source, /function\s+findNewClipAcrossTracks\s*\(/, "expected a findNewClipAcrossTracks() detection tier");
  assert.match(source, /function\s+findClipByTimeAndName\s*\(/, "expected a findClipByTimeAndName() detection tier");
  assert.match(source, /function\s+looksLikeTrackItem\s*\(/, "expected a looksLikeTrackItem() check on importMGT's own return value");
});

test("insertion failure is only reported after all detection tiers have run, and includes per-track before/after clip counts", () => {
  const source = readHostScript();
  // The failure-report object must carry both count arrays — proof every
  // track was actually checked, not just the requested/default one.
  assert.match(source, /beforeClipCounts\s*:\s*mapClipCounts\(beforeSnapshot\)/);
  assert.match(source, /afterClipCounts\s*:\s*mapClipCounts\(afterSnapshot\)/);
});

test("importMGT()'s exact return value and type are captured and logged", () => {
  const source = readHostScript();
  assert.match(source, /var\s+importReturnType\s*=\s*typeof\s+importReturnValue\s*;/);
  assert.match(source, /importReturnType/);
});

test("audio track index is resolved independently and validated against the audio track count, never assumed equal to videoTrackIndex", () => {
  const source = readHostScript();
  assert.match(source, /audioTrackCount/);
  assert.doesNotMatch(
    source,
    /var\s+audioTrackIndex\s*=\s*videoTrackIndex\s*;\s*$/m,
    "audioTrackIndex must not be a blind copy of videoTrackIndex without validating it against audioTrackCount"
  );
});

test("result payload reports the detected track index and detection method used, for full visibility", () => {
  const source = readHostScript();
  assert.match(source, /detectedTrackIndex\s*:\s*detectedTrackIndex/);
  assert.match(source, /detectionMethod\s*:\s*detectionMethod/);
});

// --- probeSourceTextDeep: read-before-write Source Text investigation ---
// See docs/CEP_BRIDGE_INVESTIGATION.md Part 8. These checks guard the
// specific discipline the user asked for: dump everything reflect-visible
// about the param BEFORE ever calling getValue()/setValue() blindly, and
// only attempt a write once a genuinely structured, constructible shape
// with an identifiable text-like field has been found.

test('dispatch() routes the "probeSourceTextDeep" command to $._captionStudioBridge.probeSourceTextDeep', () => {
  const source = readHostScript();
  assert.match(source, /command\s*===\s*["']probeSourceTextDeep["']/);
  assert.match(source, /\$\._captionStudioBridge\.probeSourceTextDeep\s*=\s*function\s*\(/);
});

test("probeSourceTextDeep dumps the param via ExtendScript's documented .reflect interface, not a blind for...in guess", () => {
  const source = readHostScript();
  assert.match(source, /function\s+dumpValueDeep\s*\(/, "expected a dumpValueDeep() helper");
  assert.match(source, /\.reflect\.properties/, "expected use of the documented ExtendScript reflect.properties introspection API");
  assert.match(source, /\.reflect\.methods/, "expected use of the documented ExtendScript reflect.methods introspection API");
});

test("probeSourceTextDeep calls getValue() and dumps its result before any setValue() call is reached", () => {
  const source = readHostScript();
  const probeFnMatch = source.match(/\$\._captionStudioBridge\.probeSourceTextDeep = function[\s\S]*$/);
  assert.ok(probeFnMatch, "expected to find the probeSourceTextDeep function body");
  const probeFnSource = probeFnMatch[0];
  const getValueIndex = probeFnSource.indexOf("sourceTextParam.getValue()");
  const setValueIndex = probeFnSource.indexOf("sourceTextParam.setValue(");
  assert.ok(getValueIndex !== -1, "expected an initial sourceTextParam.getValue() call");
  assert.ok(setValueIndex !== -1, "expected a sourceTextParam.setValue() call");
  assert.ok(getValueIndex < setValueIndex, "getValue() must be called (and its result dumped) before setValue() is ever reached");
});

test("probeSourceTextDeep only attempts setValue() when the value is a plain object or JSON string, never a live host object or a blind raw-string guess", () => {
  const source = readHostScript();
  assert.match(
    source,
    /structuredKind\s*!==\s*["']plain-object["']\s*&&\s*structuredKind\s*!==\s*["']json-string["']/,
    "expected an explicit gate skipping the write test unless the shape is a plain object or JSON string"
  );
  assert.match(source, /host-object-with-reflect/, "expected the host-object-with-reflect case to be classified and excluded from blind writes");
});

test("probeSourceTextDeep reports a before/after diff via a dedicated diff helper, not just raw before/after dumps", () => {
  const source = readHostScript();
  assert.match(source, /function\s+diffDumpedTrees\s*\(/);
  assert.match(source, /beforeAfterDiff/);
});

test("probeSourceTextDeep documents exactly where getValue() threw, on both the initial read and the post-write read-back", () => {
  const source = readHostScript();
  assert.match(source, /getValueThrowLocation/);
  assert.match(source, /readBackThrowLocation/);
});

test("hostscript.jsx stays ES3/ES5-compatible (no const/let/arrow functions/template literals) since ExtendScript can't parse modern syntax", () => {
  const source = readHostScript();
  // Strip line/block comments and string contents loosely before scanning,
  // to avoid false positives from comment text (e.g. "not `const`").
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(withoutComments, /\bconst\s+\w/, "found `const` — hostscript.jsx must use `var` only");
  assert.doesNotMatch(withoutComments, /\blet\s+\w/, "found `let` — hostscript.jsx must use `var` only");
  assert.doesNotMatch(withoutComments, /=>\s*{|=>\s*\(/, "found an arrow function — hostscript.jsx must use `function` only");
});
