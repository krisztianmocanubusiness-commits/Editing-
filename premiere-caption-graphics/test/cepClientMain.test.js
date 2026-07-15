import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const MAIN_JS_PATH = path.join(ROOT, "cep-bridge", "client", "main.js");
const RAW_EVAL_CLASSIFY_PATH = path.join(ROOT, "cep-bridge", "client", "rawEvalClassify.cjs");

// cep-bridge/client/main.js runs inside a CEP panel's browser context
// (references `document`/`CSInterface`, unavailable under plain Node), so
// — same as hostscript.jsx — these are static source-text regression
// checks, not execution tests. The pure classification logic it uses
// (classifyRawEvalResult) has no such dependency and is covered by real
// executable unit tests in test/cepRawEvalClassify.test.js instead.
//
// Real-host bug history this file guards against, in order:
// 1. All six /raw-eval bypass tests — including a bare literal with zero
//    ExtendScript dependency (JSON.stringify({ok:true})) — were reported
//    as "finished with errors". Root cause: /raw-eval attempted
//    JSON.parse() on every raw callback and conflated "isn't JSON" with
//    "ExtendScript failed". Fixed by moving classification into a
//    dedicated function (ok is false ONLY for the literal
//    "EvalScript error." string).
// 2. That fix initially required("./rawEvalClassify.cjs") — a LOCAL
//    project file, by relative path — at the very top of main.js, before
//    any DOM/status code ran. That broke the CEP panel entirely: whatever
//    went wrong with that require() call threw synchronously with no
//    try/catch around it, so NONE of main.js's code ever ran, leaving the
//    panel stuck on index.html's static "Starting…" text forever with no
//    visible error. Fixed by inlining classifyRawEvalResult directly in
//    main.js (never require()'d from a local file — only the built-in
//    "http" module is require()'d) and wrapping the entire startup
//    sequence in one top-level try/catch that renders a full, visible
//    error into the panel on any synchronous failure.

function readMainJs() {
  return fs.readFileSync(MAIN_JS_PATH, "utf8");
}

// --- Task 8: startup regression checks — browser-side CEP startup must
// never depend on require()'ing a local project file, and must always be
// able to report a startup failure visibly rather than hanging silently.

// Strip comments before scanning for actual require() CALLS (as opposed
// to this file's own header comment, which mentions require() and
// rawEvalClassify.cjs in prose while explaining the historical bug).
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

test("main.js does NOT require() any local project file by relative path — only Node's built-in \"http\" module", () => {
  const source = withoutComments(readMainJs());
  const requireCalls = [...source.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
  assert.ok(requireCalls.length > 0, "expected at least one require() call (http)");
  for (const specifier of requireCalls) {
    assert.equal(specifier, "http", `found a require() of "${specifier}" — main.js must not require() a local project file by relative path (this exact class of change broke CEP panel startup once already)`);
  }
});

test("main.js's actual CODE (outside comments) does not reference rawEvalClassify.cjs at all — classifyRawEvalResult is inlined directly, not loaded from a local file", () => {
  const source = withoutComments(readMainJs());
  assert.doesNotMatch(source, /rawEvalClassify/, "main.js's code must not reference rawEvalClassify.cjs in any way — the classifier must be inlined (the header comment may still mention it by name while explaining the historical bug)");
});

test("main.js defines its own classifyRawEvalResult() function inline", () => {
  const source = readMainJs();
  assert.match(source, /function classifyRawEvalResult\(resultString\)\s*\{/);
});

test("main.js's inlined classifyRawEvalResult stays behaviorally in sync with rawEvalClassify.cjs's separately-tested copy (task 5)", () => {
  const mainSource = readMainJs();
  const cjsSource = fs.readFileSync(RAW_EVAL_CLASSIFY_PATH, "utf8");

  function extractBody(source, label) {
    // Non-greedy match up to the closing brace at the SAME indentation as
    // the function's own opening line, whatever that indentation is (0
    // spaces in rawEvalClassify.cjs's top-level version, 2 spaces in
    // main.js's version, nested inside the startup try block) — a bare
    // `\n\}` search would over-match past main.js's function into
    // whatever comes after it.
    const startMatch = source.match(/([ \t]*)function classifyRawEvalResult\(resultString\)\s*\{/);
    assert.ok(startMatch, `expected to find classifyRawEvalResult()'s declaration in ${label}`);
    const indent = startMatch[1];
    const closeRe = new RegExp("\\n" + indent + "\\}");
    const startIdx = source.indexOf(startMatch[0]) + startMatch[0].length;
    const closeMatch = source.slice(startIdx).match(closeRe);
    assert.ok(closeMatch, `expected to find classifyRawEvalResult()'s closing brace in ${label}`);
    const body = source.slice(startIdx, startIdx + closeMatch.index);
    // Normalize whitespace/formatting differences (multi-line object
    // literal vs. single-line, trailing commas, etc.) so this compares
    // LOGIC, not style.
    return body
      .replace(/\s+/g, " ")
      .replace(/,\s*\}/g, " }")
      .trim();
  }

  const mainBody = extractBody(mainSource, "main.js");
  const cjsBody = extractBody(cjsSource, "rawEvalClassify.cjs");
  assert.equal(mainBody, cjsBody, "main.js's inlined classifyRawEvalResult() has drifted from rawEvalClassify.cjs's tested copy — keep them identical (only formatting differences are normalized away by this check)");
});

test("the ENTIRE browser-side startup sequence is wrapped in one top-level try/catch that renders a full, visible error on failure", () => {
  const source = readMainJs();
  assert.match(source, /^function renderStartupError\(err\)\s*\{/m, "expected a renderStartupError() function, defined before the try block so it works even if setup fails immediately");
  assert.match(source, /^try\s*\{/m, "expected a top-level `try {` wrapping the startup sequence");
  assert.match(source, /\}\s*catch\s*\(err\)\s*\{\s*renderStartupError\(err\);\s*\}\s*$/, "expected the file to end with `} catch (err) { renderStartupError(err); }`");
});

test("renderStartupError() depends only on document/console (not on anything defined inside the try block), so it can render even if startup fails immediately", () => {
  const source = readMainJs();
  const match = source.match(/function renderStartupError\(err\)\s*\{[\s\S]*?\n\}/);
  assert.ok(match);
  const fnSource = match[0];
  assert.doesNotMatch(fnSource, /\bcsInterface\b|\bhttp\b|\bserver\b/, "renderStartupError() must not reference anything from inside the try block");
  assert.match(fnSource, /document\.getElementById/);
});

test("startup logs/shows all four required stage markers, in order: loading client script, loading classifier, starting HTTP server, server listening (task 2)", () => {
  const source = readMainJs();
  const stage1 = source.indexOf("Loading client script");
  const stage2 = source.indexOf("Loading classifier");
  const stage3 = source.indexOf("Starting HTTP server");
  const stage4 = source.indexOf("Listening on http");
  assert.ok(stage1 !== -1, "missing 'Loading client script' stage marker");
  assert.ok(stage2 !== -1, "missing 'Loading classifier' stage marker");
  assert.ok(stage3 !== -1, "missing 'Starting HTTP server' stage marker");
  assert.ok(stage4 !== -1, "missing a 'Listening on http...' stage marker (server listening)");
  assert.ok(stage1 < stage2 && stage2 < stage3 && stage3 < stage4, "stage markers must appear in startup order in the source");
});

test("server.listen(...) is still called unconditionally at the end of startup, exactly as before the regression (task 7)", () => {
  const source = readMainJs();
  assert.match(source, /server\.listen\(PORT, HOST,/);
});

// --- Pre-existing raw-eval transport checks (still apply after the inlining fix) ---

test("runRawEvalScript() never calls JSON.parse() on the raw evalScript() callback (tasks 2/5 — /raw-eval must treat the callback as raw text only)", () => {
  const source = readMainJs();
  const match = source.match(/function runRawEvalScript\(script\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(match, "expected to find runRawEvalScript()'s body");
  assert.doesNotMatch(match[0], /JSON\.parse\(/, "runRawEvalScript() must not JSON.parse() the raw callback — that logic was the source of the false-failure bug");
});

test("runRawEvalScript() logs the raw callback's typeof, length, and JSON.stringify() before classifying it (task 1)", () => {
  const source = readMainJs();
  const match = source.match(/function runRawEvalScript\(script\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(match);
  const fnSource = match[0];
  assert.match(fnSource, /typeof\s+resultString/);
  assert.match(fnSource, /JSON\.stringify\(resultString\)/);
  assert.match(fnSource, /classifyRawEvalResult\(resultString\)/);
});

test("handleRawEval() logs the received request body and the extracted script field unconditionally (task 9 — verify /raw-eval actually receives the requested script)", () => {
  const source = readMainJs();
  const match = source.match(/async function handleRawEval\(req, res\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(match, "expected to find handleRawEval()'s body");
  assert.match(match[0], /received body:.*script field:/s);
});

test("the /raw-eval response envelope always includes ok, script, rawResult, rawResultType, rawResultLength, isEvalScriptError, and transportError (task 3)", () => {
  const source = readMainJs();
  assert.match(source, /rawEvalTransportFailure/, "expected a shared helper building the transport-failure envelope shape");
  const helperMatch = source.match(/function rawEvalTransportFailure\([\s\S]*?\n {2}\}/);
  assert.ok(helperMatch);
  for (const field of ["ok", "script", "rawResult", "rawResultType", "rawResultLength", "isEvalScriptError", "transportError"]) {
    assert.match(helperMatch[0], new RegExp("\\b" + field + "\\b"), `expected rawEvalTransportFailure() to include the "${field}" field`);
  }
});

test("ok is false only for isEvalScriptError or a transportError — never derived from JSON-parseability (task 4)", () => {
  const source = readMainJs();
  const rawEvalSection = source.slice(source.indexOf("function runRawEvalScript"), source.indexOf("function readRequestBody"));
  assert.doesNotMatch(rawEvalSection, /ok:\s*(true|false)\s*,[\s\S]{0,40}JSON\.parse/, "found `ok` seemingly derived from a JSON.parse() attempt in the raw-eval path");
});

test("/command's request-body handling still parses a real JSON envelope (unchanged) — only /raw-eval's callback classification changed", () => {
  const source = readMainJs();
  const handleCommandMatch = source.match(/async function handleCommand\(req, res\)\s*\{[\s\S]*?\n {2}\}/);
  assert.ok(handleCommandMatch);
  assert.match(handleCommandMatch[0], /JSON\.parse\(raw\)/);
});

test("the server routes POST /raw-eval to handleRawEval, distinct from POST /command", () => {
  const source = readMainJs();
  assert.match(source, /req\.method === "POST" && req\.url === "\/raw-eval"/);
  assert.match(source, /handleRawEval\(req, res\)/);
});

// --- Explicit hostscript loader (Part 16): even JSON.stringify({ok:true})
// — a pure literal with zero dependency on anything this project defines
// — was reported failing over a CEP bridge already confirmed reachable at
// the HTTP layer, narrowing the problem to CSInterface.evalScript()
// itself or to hostscript.jsx not actually being loaded. These checks
// guard the explicit $.evalFile() loader added to answer that.

function extractFnBody(source, signaturePattern, label) {
  const match = source.match(signaturePattern);
  assert.ok(match, `expected to find ${label}`);
  return match[0];
}

test("task 1: runExplicitHostscriptLoad() resolves the extension root via CSInterface.getSystemPath(SystemPath.EXTENSION)", () => {
  const source = readMainJs();
  const fnSource = extractFnBody(source, /async function runExplicitHostscriptLoad\(\)\s*\{[\s\S]*?\n {2}\}/, "runExplicitHostscriptLoad()'s body");
  assert.match(fnSource, /csInterface\.getSystemPath\(SystemPath\.EXTENSION\)/);
});

test("task 2: runExplicitHostscriptLoad() builds an absolute path to jsx/hostscript.jsx from the resolved extension root", () => {
  const source = readMainJs();
  const fnSource = extractFnBody(source, /async function runExplicitHostscriptLoad\(\)\s*\{[\s\S]*?\n {2}\}/, "runExplicitHostscriptLoad()'s body");
  assert.match(fnSource, /jsx\/hostscript\.jsx/);
});

test("task 3: runExplicitHostscriptLoad() calls $.evalFile() explicitly, via runRawEvalScript() (evalScript), before runStartupBuildCheck()/ping ever runs", () => {
  const source = readMainJs();
  const fnSource = extractFnBody(source, /async function runExplicitHostscriptLoad\(\)\s*\{[\s\S]*?\n {2}\}/, "runExplicitHostscriptLoad()'s body");
  assert.match(fnSource, /\$\.evalFile\(/);
  assert.match(fnSource, /runRawEvalScript\(evalFileScript\)/);

  // Ordering: runExplicitHostscriptLoad() must be awaited before
  // runStartupBuildCheck() (which calls "ping") inside runStartupSequence().
  const sequenceFnSource = extractFnBody(source, /async function runStartupSequence\(\)\s*\{[\s\S]*?\n {2}\}/, "runStartupSequence()'s body");
  const loadIndex = sequenceFnSource.indexOf("runExplicitHostscriptLoad()");
  const pingIndex = sequenceFnSource.indexOf("runStartupBuildCheck()");
  assert.ok(loadIndex !== -1 && pingIndex !== -1);
  assert.ok(loadIndex < pingIndex, "runExplicitHostscriptLoad() must run before runStartupBuildCheck() (ping)");
});

test("task 4: runExplicitHostscriptLoad() logs the resolved extension root, hostscript path, evalFile script, and raw evalFile callback; runStartupBuildCheck() logs the ping result", () => {
  const source = readMainJs();
  const loadFnSource = extractFnBody(source, /async function runExplicitHostscriptLoad\(\)\s*\{[\s\S]*?\n {2}\}/, "runExplicitHostscriptLoad()'s body");
  assert.match(loadFnSource, /Extension root:/);
  assert.match(loadFnSource, /Hostscript path:/);
  assert.match(loadFnSource, /evalFile script:/);
  assert.match(loadFnSource, /evalFile raw callback:/);
  assert.match(loadFnSource, /typeof \$\._captionStudioBridge after loading:/);

  const pingFnSource = extractFnBody(source, /async function runStartupBuildCheck\(\)\s*\{[\s\S]*?\n {2}\}/, "runStartupBuildCheck()'s body");
  assert.match(pingFnSource, /ping result after loading:/);
});

test("task 4: startup diagnostics are shown in a persistent panel element (#startup-diagnostics), not just the scrolling log", () => {
  const source = readMainJs();
  assert.match(source, /getElementById\("startup-diagnostics"\)/);
  assert.match(source, /function logStartupDiagnostic\(message\)/);
});

test("index.html declares the #startup-diagnostics persistent element", () => {
  const htmlPath = path.join(ROOT, "cep-bridge", "client", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /id="startup-diagnostics"/);
});

test("the evalFile path is escaped (backslashes and double quotes) before being embedded in the evalScript source string", () => {
  const source = readMainJs();
  const fnSource = extractFnBody(source, /async function runExplicitHostscriptLoad\(\)\s*\{[\s\S]*?\n {2}\}/, "runExplicitHostscriptLoad()'s body");
  // String.raw keeps every backslash/quote below exactly as typed, so these
  // are plain substring checks against the literal source text on disk —
  // no nested regex-escaping-of-escaping to get wrong.
  assert.ok(
    fnSource.includes(String.raw`replace(/\\/g, "\\\\")`),
    "expected backslash-escaping (replace(/\\/g, \"\\\\\")) of the hostscript path before embedding it in a JS string literal"
  );
  assert.ok(
    fnSource.includes(String.raw`replace(/"/g, '\\"')`),
    "expected double-quote-escaping (replace(/\"/g, '\\\"')) of the hostscript path before embedding it in a JS string literal"
  );
});

// --- testLegacySourceTextSetValue button (docs/CAPTION_GRAPHICS_ARCHITECTURE_DECISION.md's
// smallest remaining proof of concept) — wired directly into this CEP
// panel, calling runExtendScriptCommand() directly rather than requiring
// the UXP extension to be running at all.

test("the legacy setValue test button calls runExtendScriptCommand(\"testLegacySourceTextSetValue\", ...) directly, not through the UXP panel or /raw-eval", () => {
  const source = readMainJs();
  const clickHandlerMatch = source.match(/legacySetValueBtn\.addEventListener\("click",[\s\S]*?\n {4}\}\);/);
  assert.ok(clickHandlerMatch, "expected to find the legacy setValue button's click handler");
  const handlerSource = clickHandlerMatch[0];
  assert.match(handlerSource, /runExtendScriptCommand\("testLegacySourceTextSetValue",\s*\{\s*mogrtPath\s*\}/);
});

test("the legacy setValue test button reads the mogrt path from its own #legacy-mogrt-path input, not from any UXP-side state", () => {
  const source = readMainJs();
  assert.match(source, /getElementById\("legacy-mogrt-path"\)/);
  assert.match(source, /getElementById\("legacy-setvalue-btn"\)/);
  assert.match(source, /getElementById\("legacy-setvalue-result"\)/);
});

test("index.html declares the legacy setValue test's input, button, and result elements", () => {
  const htmlPath = path.join(ROOT, "cep-bridge", "client", "index.html");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(html, /id="legacy-mogrt-path"/);
  assert.match(html, /id="legacy-setvalue-btn"/);
  assert.match(html, /id="legacy-setvalue-result"/);
  assert.match(html, />Run testLegacySourceTextSetValue</, "expected the exact button label \"Run testLegacySourceTextSetValue\"");
});
