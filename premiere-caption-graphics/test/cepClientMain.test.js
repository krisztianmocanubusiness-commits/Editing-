import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MAIN_JS_PATH = path.join(ROOT, "cep-bridge", "client", "main.js");

// cep-bridge/client/main.js runs inside a CEP panel's browser context
// (references `document`/`CSInterface`, unavailable under plain Node), so
// — same as hostscript.jsx — these are static source-text regression
// checks, not execution tests. The pure classification logic it depends
// on (classifyRawEvalResult) has no such dependency and is covered by
// real executable unit tests in test/cepRawEvalClassify.test.js instead.
//
// Real-host bug this file guards against: all six /raw-eval bypass tests
// — including a bare literal with zero ExtendScript dependency
// (JSON.stringify({ok:true})) — were reported as "finished with errors".
// The fix moved raw-callback classification into a shared, testable
// module and removed the JSON.parse()-based classification /raw-eval used
// to do. These checks make sure that fix can't silently regress.

function readMainJs() {
  return fs.readFileSync(MAIN_JS_PATH, "utf8");
}

test("main.js requires the shared classifyRawEvalResult() helper (not a local, unverifiable copy of the same logic)", () => {
  const source = readMainJs();
  assert.match(source, /require\(["']\.\/rawEvalClassify\.cjs["']\)/);
  assert.match(source, /classifyRawEvalResult/);
});

test("runRawEvalScript() never calls JSON.parse() on the raw evalScript() callback (tasks 2/5 — /raw-eval must treat the callback as raw text only)", () => {
  const source = readMainJs();
  const match = source.match(/function runRawEvalScript\(script\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "expected to find runRawEvalScript()'s body");
  assert.doesNotMatch(match[0], /JSON\.parse\(/, "runRawEvalScript() must not JSON.parse() the raw callback — that logic was the source of the false-failure bug");
});

test("runRawEvalScript() logs the raw callback's typeof, length, and JSON.stringify() before classifying it (task 1)", () => {
  const source = readMainJs();
  const match = source.match(/function runRawEvalScript\(script\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match);
  const fnSource = match[0];
  assert.match(fnSource, /typeof\s+resultString/);
  assert.match(fnSource, /JSON\.stringify\(resultString\)/);
  assert.match(fnSource, /classifyRawEvalResult\(resultString\)/);
});

test("handleRawEval() logs the received request body and the extracted script field unconditionally (task 9 — verify /raw-eval actually receives the requested script)", () => {
  const source = readMainJs();
  const match = source.match(/async function handleRawEval\(req, res\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match, "expected to find handleRawEval()'s body");
  assert.match(match[0], /received body:.*script field:/s);
});

test("the /raw-eval response envelope always includes ok, script, rawResult, rawResultType, rawResultLength, isEvalScriptError, and transportError (task 3)", () => {
  const source = readMainJs();
  assert.match(source, /rawEvalTransportFailure/, "expected a shared helper building the transport-failure envelope shape");
  const helperMatch = source.match(/function rawEvalTransportFailure\([\s\S]*?\n\}/);
  assert.ok(helperMatch);
  for (const field of ["ok", "script", "rawResult", "rawResultType", "rawResultLength", "isEvalScriptError", "transportError"]) {
    // Allow either `field: value` or ES6 shorthand `field` (as a bare
    // property, e.g. the shorthand `transportError` used here).
    assert.match(helperMatch[0], new RegExp("\\b" + field + "\\b"), `expected rawEvalTransportFailure() to include the "${field}" field`);
  }
});

test("ok is false only for isEvalScriptError or a transportError — never derived from JSON-parseability (task 4)", () => {
  const source = readMainJs();
  // classifyRawEvalResult() (the single source of truth for the
  // ExtendScript-side ok/isEvalScriptError classification) lives in
  // rawEvalClassify.cjs and is covered by its own executable unit tests;
  // this just confirms main.js doesn't ALSO compute `ok` some other way
  // (e.g. from a JSON.parse() success/failure) anywhere in the raw-eval
  // path.
  const rawEvalSection = source.slice(source.indexOf("function runRawEvalScript"), source.indexOf("function readRequestBody"));
  assert.doesNotMatch(rawEvalSection, /ok:\s*(true|false)\s*,[\s\S]{0,40}JSON\.parse/, "found `ok` seemingly derived from a JSON.parse() attempt in the raw-eval path");
});

test("/command's request-body handling still parses a real JSON envelope (unchanged) — only /raw-eval's callback classification changed", () => {
  const source = readMainJs();
  const handleCommandMatch = source.match(/async function handleCommand\(req, res\)\s*\{[\s\S]*?\n\}/);
  assert.ok(handleCommandMatch);
  assert.match(handleCommandMatch[0], /JSON\.parse\(raw\)/);
});

test('the server routes POST /raw-eval to handleRawEval, distinct from POST /command', () => {
  const source = readMainJs();
  assert.match(source, /req\.method === "POST" && req\.url === "\/raw-eval"/);
  assert.match(source, /handleRawEval\(req, res\)/);
});
