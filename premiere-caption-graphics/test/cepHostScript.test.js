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

// --- inspectSourceTextRawBytes: byte-level string inspection ---
// See docs/CEP_BRIDGE_INVESTIGATION.md Part 9. Built to explain an
// internally inconsistent real-host result (typeof "string", a preview
// that looked like "{}", yet JSON.parse() failing / structuredKind
// "none"). These checks guard: the file must be plain UTF-8 text (a
// literal NUL byte accidentally landed in this file once during
// development and silently corrupted it — see the commit history), the
// new command must be wired in, must never call setValue(), and must
// perform the specific byte-level checks the task asked for.

test("hostscript.jsx contains no literal NUL bytes (must be clean UTF-8 text, not corrupted by an accidental binary character)", () => {
  const buffer = fs.readFileSync(HOSTSCRIPT_PATH);
  assert.equal(buffer.includes(0x00), false, "found a literal NUL byte in hostscript.jsx — it must only ever use the \\u0000 escape sequence in source, never an actual NUL character");
});

test('dispatch() routes the "inspectSourceTextRawBytes" command to $._captionStudioBridge.inspectSourceTextRawBytes', () => {
  const source = readHostScript();
  assert.match(source, /command\s*===\s*["']inspectSourceTextRawBytes["']/);
  assert.match(source, /\$\._captionStudioBridge\.inspectSourceTextRawBytes\s*=\s*function\s*\(/);
});

function extractInspectRawBytesFnSource() {
  const source = readHostScript();
  // Bound the match to just this function's body — from its definition up
  // to (but not including) testRawBytesHelpers, the next function defined
  // in the file — so assertions about "never calls setValue()" etc. can't
  // accidentally pass/fail because of unrelated code in a sibling function.
  const match = source.match(/\$\._captionStudioBridge\.inspectSourceTextRawBytes = function[\s\S]*?\n};\n/);
  assert.ok(match, "expected to find the inspectSourceTextRawBytes function body");
  return match[0];
}

function extractTestRawBytesHelpersFnSource() {
  const source = readHostScript();
  // Bound the match to just this function's body — from its definition up
  // to (but not including) bisectHostScript, the next function defined in
  // the file — so assertions like "never references app.project" can't
  // accidentally fail (or pass) because of unrelated code/comments in a
  // sibling function. Same pattern used for inspectSourceTextRawBytes's
  // extraction helper above.
  const match = source.match(/\$\._captionStudioBridge\.testRawBytesHelpers = function[\s\S]*?\n};\n/);
  assert.ok(match, "expected to find the testRawBytesHelpers function body");
  return match[0];
}

test("inspectSourceTextRawBytes never calls setValue() anywhere in its body", () => {
  const fnSource = extractInspectRawBytesFnSource();
  assert.doesNotMatch(fnSource, /\.setValue\s*\(/, "inspectSourceTextRawBytes must never call setValue() — read-only byte inspection only");
});

test("inspectSourceTextRawBytes logs the exact string length, JSON.stringify of the raw value, and a full character code + hex dump", () => {
  const source = readHostScript();
  const fnSource = extractInspectRawBytesFnSource();
  assert.match(fnSource, /result\.rawStringLength\s*=\s*rawValue\.length/);
  assert.match(fnSource, /result\.jsonStringifyOfRawValue\s*=\s*JSON\.stringify\(rawValue\)/);
  assert.match(source, /function\s+charCodeHexDump\s*\(/, "expected a top-level charCodeHexDump() helper");
  assert.match(fnSource, /result\.charCodeDump\s*=\s*charCodeHexDump\(/);
});

test("inspectSourceTextRawBytes logs the first and last 32 characters separately", () => {
  const fnSource = extractInspectRawBytesFnSource();
  assert.match(fnSource, /result\.first32\s*=/);
  assert.match(fnSource, /result\.last32\s*=/);
});

test("inspectSourceTextRawBytes attempts JSON.parse on the raw value plus trimmed/BOM-stripped/null-stripped/fully-normalized variants, each capturing the exact error and position", () => {
  const source = readHostScript();
  assert.match(source, /function\s+tryJsonParse\s*\(/, "expected a tryJsonParse() helper capturing ok/error/errorPosition");
  assert.match(source, /posMatch\s*=\s*entry\.error\.match\(\/position/i, "expected the failure position to be parsed out of the JSON.parse error message");
  const fnSource = extractInspectRawBytesFnSource();
  assert.match(fnSource, /tryJsonParse\(\s*["']raw["']/);
  assert.match(fnSource, /tryJsonParse\(\s*["']trimmed["']/);
  assert.match(fnSource, /tryJsonParse\(\s*["']bom-stripped["']/);
  assert.match(fnSource, /tryJsonParse\(\s*["']null-stripped["']/);
  assert.match(fnSource, /result\.jsonParseAttempts\s*=\s*\[/);
});

test("inspectSourceTextRawBytes saves the full result to a JSON file via the documented ExtendScript File/Folder API", () => {
  const source = readHostScript();
  assert.match(source, /function\s+saveDiagnosticJson\s*\(/);
  assert.match(source, /new File\(Folder\.temp\.fsName/, "expected the diagnostic file to be written via Folder.temp — ExtendScript's documented temp-folder global");
  const fnSource = extractInspectRawBytesFnSource();
  assert.match(fnSource, /saveDiagnosticJson\(/);
});

// --- Real-host bug: inspectSourceTextRawBytes() failed with a non-JSON
// "EvalScript error." response instead of a structured JSON failure. Per
// the CEP evalScript contract, that literal string is returned when the
// ExtendScript engine faults in a way that escapes normal script-level
// try/catch, so this section (a) hardens the command with a top-level
// try/catch + pipeline stage tracking so any NORMAL catchable exception
// always comes back as valid JSON with a `stage` telling us exactly where,
// and (b) adds a standalone command that exercises the same byte/JSON
// helpers with zero Premiere host object access, to isolate whether the
// fault is in that string-processing logic or in the MOGRT/file-I/O path.
// See docs/CEP_BRIDGE_INVESTIGATION.md Part 10.

test("inspectSourceTextRawBytes wraps its ENTIRE body in one top-level try/catch that returns a stage-tagged failure envelope", () => {
  const fnSource = extractInspectRawBytesFnSource();
  const tryIndex = fnSource.indexOf("try {");
  const catchIndex = fnSource.indexOf("} catch (fatalErr) {");
  assert.ok(tryIndex !== -1, "expected a top-level try { at the start of the function body");
  assert.ok(catchIndex !== -1, "expected a top-level } catch (fatalErr) { wrapping the whole function body");
  assert.match(fnSource, /return buildFatalFailure\(requestId, stage, diagnostics, fatalErr\);/);
});

test("buildFatalFailure() returns ok:false with stage, error, errorLine, errorFileName, errorStack", () => {
  const source = readHostScript();
  assert.match(source, /function\s+buildFatalFailure\s*\(/);
  assert.match(source, /ok:\s*false,[\s\S]{0,120}stage:\s*stage,[\s\S]{0,120}error:\s*message,[\s\S]{0,120}errorLine:\s*line,[\s\S]{0,120}errorFileName:\s*fileName,[\s\S]{0,120}errorStack:\s*stack,/);
});

test("inspectSourceTextRawBytes tags every phase with an early stage marker: argument-parsing, mogrt-insertion, source-text-lookup, raw-string-inspection, json-serialization, temp-file-writing", () => {
  const source = readHostScript();
  assert.match(source, /var\s+STAGE_ARGUMENT_PARSING\s*=\s*["']argument-parsing["']/);
  assert.match(source, /var\s+STAGE_MOGRT_INSERTION\s*=\s*["']mogrt-insertion["']/);
  assert.match(source, /var\s+STAGE_SOURCE_TEXT_LOOKUP\s*=\s*["']source-text-lookup["']/);
  assert.match(source, /var\s+STAGE_RAW_STRING_INSPECTION\s*=\s*["']raw-string-inspection["']/);
  assert.match(source, /var\s+STAGE_JSON_SERIALIZATION\s*=\s*["']json-serialization["']/);
  assert.match(source, /var\s+STAGE_TEMP_FILE_WRITING\s*=\s*["']temp-file-writing["']/);

  const fnSource = extractInspectRawBytesFnSource();
  assert.match(fnSource, /stage\s*=\s*STAGE_MOGRT_INSERTION/);
  assert.match(fnSource, /stage\s*=\s*STAGE_SOURCE_TEXT_LOOKUP/);
  assert.match(fnSource, /stage\s*=\s*STAGE_RAW_STRING_INSPECTION/);
  assert.match(fnSource, /stage\s*=\s*STAGE_JSON_SERIALIZATION/);
  assert.match(fnSource, /stage\s*=\s*STAGE_TEMP_FILE_WRITING/);
});

test("inspectSourceTextRawBytes never calls setValue() even inside its top-level try/catch (task 6/7 still hold after hardening)", () => {
  const fnSource = extractInspectRawBytesFnSource();
  assert.doesNotMatch(fnSource, /\.setValue\s*\(/);
});

test('dispatch() routes the "testRawBytesHelpers" command to $._captionStudioBridge.testRawBytesHelpers', () => {
  const source = readHostScript();
  assert.match(source, /command\s*===\s*["']testRawBytesHelpers["']/);
  assert.match(source, /\$\._captionStudioBridge\.testRawBytesHelpers\s*=\s*function\s*\(/);
});

test("testRawBytesHelpers touches zero Premiere host objects (no app.project, no sequence, no importMGT/getValue/setValue) and reuses the same byte/JSON helpers", () => {
  const fnSource = extractTestRawBytesHelpersFnSource();
  assert.doesNotMatch(fnSource, /app\.project/, "testRawBytesHelpers must not touch app.project — it exists specifically to test in isolation from Premiere host objects");
  assert.doesNotMatch(fnSource, /\.activeSequence/);
  assert.doesNotMatch(fnSource, /importMGT/);
  assert.doesNotMatch(fnSource, /\.getValue\s*\(/);
  assert.doesNotMatch(fnSource, /\.setValue\s*\(/);
  assert.match(fnSource, /charCodeHexDump\(/, "expected testRawBytesHelpers to reuse the real charCodeHexDump() helper");
  assert.match(fnSource, /tryJsonParse\(/, "expected testRawBytesHelpers to reuse the real tryJsonParse() helper");
  assert.match(fnSource, /return buildFatalFailure\(requestId, stage, diagnostics, fatalErr\);/, "expected testRawBytesHelpers to use the same stage-tagged failure envelope");
});

// --- Task 2/9: block specific ExtendScript-incompatible syntax/features ---

test("hostscript.jsx never uses null-character/BOM string escape literals — uses stripNullChars()/String.fromCharCode() instead, to avoid any Unicode-escape-parsing ambiguity in ExtendScript's older engine", () => {
  const source = readHostScript();
  assert.match(source, /function\s+stripNullChars\s*\(/, "expected a stripNullChars() helper that strips null characters via charCodeAt(), not a regex/string escape literal");
  assert.match(source, /String\.fromCharCode\(0\)/, "expected the null character to be constructed via String.fromCharCode(0) rather than an escape literal");
});

test("hostscript.jsx stays ES3/ES5-compatible: no const/let, no arrow functions, no template literals, no startsWith/endsWith/codePointAt, no Array.prototype.map/filter/reduce, no Object.keys on host objects", () => {
  const source = readHostScript();
  // Strip line/block comments before scanning, to avoid false positives
  // from comment text (e.g. this test's own name mentioning `const`).
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(withoutComments, /\bconst\s+\w/, "found `const` — hostscript.jsx must use `var` only");
  assert.doesNotMatch(withoutComments, /\blet\s+\w/, "found `let` — hostscript.jsx must use `var` only");
  assert.doesNotMatch(withoutComments, /=>\s*{|=>\s*\(/, "found an arrow function — hostscript.jsx must use `function` only");
  assert.doesNotMatch(withoutComments, /`/, "found a backtick — hostscript.jsx must use string concatenation, never template literals");
  assert.doesNotMatch(withoutComments, /\.startsWith\s*\(/, "found String.prototype.startsWith() — not guaranteed on ExtendScript's older engine");
  assert.doesNotMatch(withoutComments, /\.endsWith\s*\(/, "found String.prototype.endsWith() — not guaranteed on ExtendScript's older engine");
  assert.doesNotMatch(withoutComments, /\.codePointAt\s*\(/, "found String.prototype.codePointAt() — not guaranteed on ExtendScript's older engine");
  assert.doesNotMatch(withoutComments, /\.map\s*\(function|\.filter\s*\(function|\.reduce\s*\(function/, "found Array.prototype.map/filter/reduce — use a plain for loop instead");
  assert.doesNotMatch(withoutComments, /Object\.keys\s*\(/, "found Object.keys() — host object properties aren't reliably enumerable this way; use .reflect.properties instead (see dumpValueDeep)");
});

// --- bisectHostScript: incremental bisection to find the exact breaking
// statement, per the user's explicit instruction to stop adding
// diagnostics and instead test one addition at a time. See
// docs/CEP_BRIDGE_INVESTIGATION.md Part 11.

test('dispatch() routes the "bisectHostScript" command to $._captionStudioBridge.bisectHostScript', () => {
  const source = readHostScript();
  assert.match(source, /command\s*===\s*["']bisectHostScript["']/);
  assert.match(source, /\$\._captionStudioBridge\.bisectHostScript\s*=\s*function\s*\(/);
});

function extractBisectFnSource() {
  const source = readHostScript();
  const match = source.match(/\$\._captionStudioBridge\.bisectHostScript = function[\s\S]*$/);
  assert.ok(match, "expected to find the bisectHostScript function body");
  return match[0];
}

test("bisectHostScript never touches app/project/sequence at any step (task 5)", () => {
  const fnSource = extractBisectFnSource();
  assert.doesNotMatch(fnSource, /app\.project/, "bisectHostScript must never reference app.project — it exists specifically to isolate the fault from Premiere host objects");
  assert.doesNotMatch(fnSource, /\.activeSequence/);
  assert.doesNotMatch(fnSource, /importMGT/);
});

test("bisectHostScript's step 0 returns a minimal object identical in shape to the already-working ping command", () => {
  const fnSource = extractBisectFnSource();
  assert.match(fnSource, /step === 0/);
  assert.match(fnSource, /stepName:\s*"minimal object return \(same shape as ping\)"/);
});

test("bisectHostScript progresses through every requested incremental construct: a string literal, .length, JSON.stringify, a charCodeAt loop, hex conversion, the real charCodeHexDump/tryJsonParse/stripNullChars helpers, and finally the real testRawBytesHelpers command", () => {
  const fnSource = extractBisectFnSource();
  assert.match(fnSource, /var\s+s2\s*=\s*"\{\}";/, "step 2: string literal");
  assert.match(fnSource, /var\s+len3\s*=\s*s3\.length;/, "step 3: .length");
  assert.match(fnSource, /var\s+stringified4\s*=\s*JSON\.stringify\(s4\);/, "step 4: JSON.stringify");
  assert.match(fnSource, /codes5\.push\(s5\.charCodeAt\(i5\)\);/, "step 5: charCodeAt loop");
  assert.match(fnSource, /code6\.toString\(16\)/, "step 6: hex conversion");
  assert.match(fnSource, /var\s+dump7\s*=\s*charCodeHexDump\("\{\}",\s*10\);/, "step 7: real charCodeHexDump()");
  assert.match(fnSource, /JSON\.parse\("\{\}"\);/, "step 8: bare JSON.parse in try/catch");
  assert.match(fnSource, /var\s+attempt9\s*=\s*tryJsonParse\("bisect",\s*"\{\}"\);/, "step 9: real tryJsonParse()");
  assert.match(fnSource, /var\s+stripped10\s*=\s*stripNullChars\(/, "step 10: real stripNullChars()");
  assert.match(fnSource, /\$\._captionStudioBridge\.testRawBytesHelpers\(\{\},\s*requestId\)/, "step 11: the real testRawBytesHelpers() command");
});

test("bisectHostScript tests exactly one new construct per step — never combines two untested features in a single step body", () => {
  const fnSource = extractBisectFnSource();
  // Each `if (step === N) { ... }` block, up through step 6 (the last
  // step built from scratch rather than calling an already-defined real
  // helper), should contain at most one "new" call/operator beyond what
  // the previous step already covered. Concretely: step 2 shouldn't yet
  // call .length or JSON.stringify; step 3 shouldn't yet call
  // JSON.stringify or run a charCodeAt loop, etc. — checked by making
  // sure each numbered step block is small (a handful of lines), which
  // is what "one statement at a time" means in practice here.
  const stepBlocks = fnSource.match(/if \(step === \d+\) \{[\s\S]*?\n    \}\n/g) || [];
  assert.ok(stepBlocks.length >= 10, "expected at least steps 0-9 as separate, individually small if-blocks");
  for (const block of stepBlocks) {
    const lineCount = block.split("\n").length;
    assert.ok(lineCount <= 12, `a bisect step block is unexpectedly large (${lineCount} lines) — each step should add only one construct:\n${block}`);
  }
});

// --- Real-host finding that redirects the whole investigation: even
// bisectHostScript's step 0 (a bare minimal return, no helpers, no
// Premiere APIs) fails with the same "EvalScript error." as everything
// added since probeSourceTextDeep (still confirmed working). Since a full
// audit found nothing structurally wrong in this file (see the two tests
// below), the leading theory is that Premiere's ExtendScript engine only
// evaluates the manifest's ScriptPath file ONCE per running process — so
// this section adds an independently-checkable build identifier, a
// command list, and a minimal command (echoPayload) placed as far from
// bisectHostScript as possible in the file, per the user's explicit
// tasks. See docs/CEP_BRIDGE_INVESTIGATION.md Part 12.

test("every $._captionStudioBridge.X = function(...) command handler is defined at column 0 (true top-level/global scope, never nested inside another function)", () => {
  const source = readHostScript();
  const handlerLines = source.split("\n").filter((line) => /\$\._captionStudioBridge\.\w+\s*=\s*function/.test(line));
  assert.ok(handlerLines.length >= 8, "expected at least 8 registered command handlers (ping's caller, dispatch, and the real commands)");
  for (const line of handlerLines) {
    assert.match(line, /^\$\._captionStudioBridge\./, `handler line is indented (not top-level/global scope): ${JSON.stringify(line)}`);
  }
});

test("hostscript.jsx's braces are perfectly balanced (no unmatched brace anywhere in the file)", () => {
  const source = readHostScript();
  let depth = 0;
  let inString = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && source[i + 1] === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === inString) inString = null;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      inString = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      assert.ok(depth >= 0, `found an unmatched closing brace at character offset ${i}`);
    }
  }
  assert.equal(depth, 0, "braces are not balanced across the whole file — expected every { to have a matching }");
});

test("HOSTSCRIPT_BUILD_ID and SUPPORTED_COMMANDS are declared, and ping()'s result includes both — so a caller can directly confirm what's loaded in the live ExtendScript engine (task 6)", () => {
  const source = readHostScript();
  assert.match(source, /var\s+HOSTSCRIPT_BUILD_ID\s*=\s*["'][^"']+["'];/);
  assert.match(source, /var\s+SUPPORTED_COMMANDS\s*=\s*\[/);
  assert.match(source, /hostscriptBuildId:\s*HOSTSCRIPT_BUILD_ID/);
  assert.match(source, /supportedCommands:\s*SUPPORTED_COMMANDS/);
});

test("SUPPORTED_COMMANDS lists every real command name dispatch() actually routes", () => {
  const source = readHostScript();
  const dispatchCommands = [...source.matchAll(/command\s*===\s*["'](\w+)["']/g)].map((m) => m[1]);
  const listMatch = source.match(/var\s+SUPPORTED_COMMANDS\s*=\s*\[([\s\S]*?)\];/);
  assert.ok(listMatch, "expected to find the SUPPORTED_COMMANDS array literal");
  const declared = [...listMatch[1].matchAll(/"(\w+)"/g)].map((m) => m[1]);
  for (const cmd of dispatchCommands) {
    assert.ok(declared.includes(cmd), `dispatch() routes "${cmd}" but SUPPORTED_COMMANDS doesn't list it — bump it so getAvailableCommands()/ping() stay accurate`);
  }
});

test('dispatch() routes "getAvailableCommands" to $._captionStudioBridge.getAvailableCommands()', () => {
  const source = readHostScript();
  assert.match(source, /command\s*===\s*["']getAvailableCommands["']/);
  assert.match(source, /\$\._captionStudioBridge\.getAvailableCommands\s*=\s*function\s*\(/);
});

test('dispatch() routes "echoPayload" to $._captionStudioBridge.echoPayload() — task 3\'s minimal, ping-like command', () => {
  const source = readHostScript();
  assert.match(source, /command\s*===\s*["']echoPayload["']/);
  assert.match(source, /\$\._captionStudioBridge\.echoPayload\s*=\s*function\s*\(payload,\s*requestId\)\s*\{/);
});

test("echoPayload uses the exact same registration/return pattern as probeSourceTextDeep — a plain object return, no helper functions, no Premiere APIs — and is placed near the TOP of the file, far from bisectHostScript", () => {
  const source = readHostScript();
  const echoMatch = source.match(/\$\._captionStudioBridge\.echoPayload = function[\s\S]*?\n\};/);
  assert.ok(echoMatch, "expected to find the echoPayload function body");
  const echoFnSource = echoMatch[0];
  assert.match(echoFnSource, /return\s*\{\s*ok:\s*true,\s*requestId:\s*requestId,\s*result:/, "expected a plain-object return, matching every other command's convention (dispatch() does the one JSON.stringify)");
  assert.doesNotMatch(echoFnSource, /app\.project|\.activeSequence|importMGT|snapshotAllVideoTracks|charCodeHexDump|tryJsonParse|stripNullChars/, "echoPayload must not call any Premiere API or helper function — it's the minimal isolated test case");

  const echoIndex = source.indexOf("$._captionStudioBridge.echoPayload = function");
  const bisectIndex = source.indexOf("$._captionStudioBridge.bisectHostScript = function");
  assert.ok(echoIndex !== -1 && bisectIndex !== -1);
  assert.ok(echoIndex < bisectIndex, "echoPayload should be defined well before bisectHostScript in the file, to test whether position-in-file matters");
});

// --- Part 13: a full Premiere restart did NOT fix
// getAvailableCommands/echoPayload/bisectHostScript, disproving the Part
// 12 engine-caching hypothesis. These checks guard the bypass-the-
// dispatcher isolation tooling: a bare-global, brand-new, minimal
// function (echoPayloadDirect) that a bypass evalScript call can invoke
// directly, with zero involvement of $._captionStudioBridge or
// dispatch(). See docs/CEP_BRIDGE_INVESTIGATION.md Part 13.

test("echoPayloadDirect is declared as a bare top-level function (not a $._captionStudioBridge property), distinct from the namespaced echoPayload command, for direct bare-global evalScript invocation", () => {
  const source = readHostScript();
  assert.match(source, /^function echoPayloadDirect\(payloadString\)\s*\{/m, "expected a bare top-level `function echoPayloadDirect(payloadString) {` declaration");
  assert.doesNotMatch(source, /\$\._captionStudioBridge\.echoPayloadDirect/, "echoPayloadDirect must NOT be attached to $._captionStudioBridge — it exists specifically to test bare-global invocation");
});

test("echoPayloadDirect takes one string argument, returns a JSON string directly (not a plain object — it bypasses dispatch()'s own JSON.stringify entirely), and calls no Premiere APIs or other helpers", () => {
  const source = readHostScript();
  const match = source.match(/function echoPayloadDirect\(payloadString\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "expected to find echoPayloadDirect's body");
  const fnSource = match[0];
  assert.match(fnSource, /return\s+JSON\.stringify\(/, "expected echoPayloadDirect to pre-stringify its own return value, since it's called directly, not through dispatch()");
  assert.doesNotMatch(fnSource, /app\.project|\.activeSequence|importMGT|\$\._captionStudioBridge/);
});

test("basenameNoExt (used indirectly by the confirmed-working probeSourceTextDeep) remains a bare top-level function, suitable as the known-working bare-global bypass target", () => {
  const source = readHostScript();
  assert.match(source, /^function basenameNoExt\(path\)\s*\{/m);
});
