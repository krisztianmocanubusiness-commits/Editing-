/**
 * CEP-side bridge: hosts a local HTTP server (via CEP's Node.js
 * integration — this manifest sets --enable-nodejs and --mixed-context, so
 * this same script has both `require()` and the browser/CSInterface APIs
 * in one context, per docs/CEP_BRIDGE_INVESTIGATION.md Part 4) and
 * dispatches each request into ExtendScript via CSInterface.evalScript().
 *
 * UXP cannot host a server (client-only — see the investigation doc), so
 * this is deliberately the server side of the pair: the UXP panel is the
 * client (src/ppro/cepBridge.js), this is the server.
 *
 * Contract (see docs/CEP_BRIDGE_INVESTIGATION.md Part 4 for the full
 * request/response shape):
 *   POST /command  { command, payload, requestId } -> { ok, requestId, result | error }
 *   GET  /health    -> { ok: true, extendscriptReady: boolean }
 * Always HTTP 200 for application-level results — failures are reported in
 * the JSON body, never via HTTP status, so the client has one shape to parse.
 */

// eslint-disable-next-line no-undef
const http = require("http");
// eslint-disable-next-line no-undef
// .cjs extension (not .js) so this loads as CommonJS unambiguously,
// regardless of any package.json "type" field Node might otherwise
// consult — this file is also imported directly by
// test/cepRawEvalClassify.test.js under plain Node.
const { classifyRawEvalResult } = require("./rawEvalClassify.cjs");

const PORT = 3010;
const HOST = "127.0.0.1"; // local-only — never bind 0.0.0.0 for a bridge that can execute host scripting.
const EVALSCRIPT_TIMEOUT_MS = 15000;

const csInterface = new CSInterface();

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");
const lastEvalScriptEl = document.getElementById("last-eval-script");

function log(message, level) {
  const time = new Date().toLocaleTimeString();
  // eslint-disable-next-line no-console
  console[level === "error" ? "error" : "log"](`[CEP Bridge] ${message}`);
  const line = document.createElement("div");
  line.textContent = `${time}  ${message}`;
  if (level === "error") line.style.color = "#e05f5f";
  if (level === "success") line.style.color = "#57c26a";
  logEl.appendChild(line);
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text, ok) {
  statusEl.textContent = text;
  statusEl.style.borderColor = ok ? "#57c26a" : "#e05f5f";
}

// Task 2: shows the exact evalScript() source string in a persistent,
// always-visible panel element (not just the scrolling log) immediately
// before the call is made.
function showLastEvalScript(script) {
  if (lastEvalScriptEl) lastEvalScriptEl.textContent = script;
}

/**
 * Runs one command in ExtendScript via evalScript, with its own timeout so
 * a stuck host script can't hang the HTTP response forever. The .jsx side
 * (jsx/hostscript.jsx) exposes a single dispatch(requestJsonString) entry
 * point that JSON.parses the request, runs the named command, and returns
 * JSON.stringify(result) — evalScript's callback receives that string
 * directly (evalScript can only return a string).
 */
function runExtendScriptCommand(command, payload, requestId) {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, requestId, error: `ExtendScript did not respond within ${EVALSCRIPT_TIMEOUT_MS}ms.`, _evalScriptSource: script });
    }, EVALSCRIPT_TIMEOUT_MS);

    const requestJson = JSON.stringify({ command, payload, requestId });
    // Double-encode: JSON.stringify(requestJson) turns the JSON string into
    // a safely-escaped JS string literal to embed directly in the
    // evalScript call, so hostscript.jsx's dispatch() receives it as a
    // single string argument and does its own JSON.parse().
    const script = `$._captionStudioBridge.dispatch(${JSON.stringify(requestJson)})`;

    // Task 1/2: log AND display (persistently, not just scrolled into the
    // log) the exact evalScript source string immediately before calling
    // evalScript() — lets a byte-for-byte comparison between a
    // known-working command's call (e.g. probeSourceTextDeep) and a
    // failing one's (e.g. bisectHostScript/echoPayload) rule in or out any
    // difference in how the call itself is constructed, independent of
    // what's actually loaded in the ExtendScript engine. Also attached to
    // every resolved result as `_evalScriptSource` so the UXP-side panel
    // can display/compare it too, not just this CEP panel.
    log(`evalScript source for "${command}": ${script}`, "info");
    showLastEvalScript(script);

    try {
      csInterface.evalScript(script, (resultString) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        // Task 7: log the raw callback result exactly as received, before
        // any JSON parsing is attempted — exact string, length, and a
        // JSON.stringify() of it (reveals whether it's really the literal
        // "EvalScript error." string or something subtly different).
        log(
          `raw evalScript() callback for "${command}": length=${resultString === undefined ? "n/a" : String(resultString).length}, ` +
            `JSON.stringify=${JSON.stringify(resultString)}`,
          "info"
        );
        if (resultString === undefined || resultString === null || resultString === "") {
          resolve({ ok: false, requestId, error: "evalScript returned an empty result.", _evalScriptSource: script });
          return;
        }
        try {
          const parsed = JSON.parse(resultString);
          parsed._evalScriptSource = script;
          resolve(parsed);
        } catch (err) {
          // evalScript itself surfaces host-side syntax/runtime errors as
          // a string starting with "EvalScript error" rather than JSON.
          resolve({
            ok: false,
            requestId,
            error: `Non-JSON response from ExtendScript: ${resultString}`,
            parseError: String(err.message || err),
            _evalScriptSource: script,
            _rawResult: resultString,
            _rawResultLength: String(resultString).length,
            _rawResultJsonStringify: JSON.stringify(resultString),
          });
        }
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ ok: false, requestId, error: `evalScript threw synchronously: ${err.message || err}`, _evalScriptSource: script });
    }
  });
}

/**
 * Task 4/6/7: runs an arbitrary, literal ExtendScript source string
 * directly via evalScript() — completely bypassing
 * runExtendScriptCommand()'s `$._captionStudioBridge.dispatch(...)`
 * wrapper, the JSON request envelope, and hostscript.jsx's dispatch()
 * function entirely. Used to isolate exactly which invocation layer
 * fails: a pure literal with zero references to this project's code, a
 * bare-global already-existing helper function
 * (e.g. `basenameNoExt(...)`, used indirectly by the confirmed-working
 * probeSourceTextDeep), a bare-global brand-new minimal function
 * (`echoPayloadDirect(...)`), a bare (incorrectly-scoped, expected to
 * fail) reference to `dispatch(...)`, or a hand-written, pre-escaped call
 * to the correctly-scoped `$._captionStudioBridge.dispatch(...)` for both
 * a known-working and a known-failing command.
 *
 * Treats the evalScript() callback as RAW TEXT ONLY (tasks 2/5 — this
 * function never calls JSON.parse() on it; classification is delegated to
 * classifyRawEvalResult(), which is ok:false ONLY when the raw text is
 * EXACTLY the literal "EvalScript error." string, or when the
 * transport/CEP layer itself throws below — never because the text
 * "isn't JSON", since most of the bypass scripts above intentionally
 * don't return JSON at all).
 */
function runRawEvalScript(script) {
  return new Promise((resolve) => {
    let settled = false;
    const timeoutHandle = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        ok: false,
        script,
        rawResult: null,
        rawResultType: "undefined",
        rawResultLength: 0,
        isEvalScriptError: false,
        transportError: `evalScript did not respond within ${EVALSCRIPT_TIMEOUT_MS}ms.`,
      });
    }, EVALSCRIPT_TIMEOUT_MS);

    log(`raw bypass evalScript source: ${script}`, "info");
    showLastEvalScript(script);

    try {
      csInterface.evalScript(script, (resultString) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);

        // Task 1: log the exact callback — raw value, typeof, length,
        // JSON.stringify() of it, and whether it's literally
        // "EvalScript error." — BEFORE any classification/interpretation.
        const classified = classifyRawEvalResult(resultString);
        log(
          `raw bypass evalScript() callback: typeof=${typeof resultString}, length=${classified.rawResultLength}, ` +
            `JSON.stringify=${JSON.stringify(resultString)}, isEvalScriptError=${classified.isEvalScriptError}`,
          "info"
        );

        resolve({ ...classified, script, transportError: null });
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({
        ok: false,
        script,
        rawResult: null,
        rawResultType: "undefined",
        rawResultLength: 0,
        isEvalScriptError: false,
        transportError: `evalScript threw synchronously: ${err.message || err}`,
      });
    }
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    // Local-only tool; permissive CORS just means "any local page can
    // reach this local server", not a real cross-origin exposure.
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

async function handleCommand(req, res) {
  let parsedBody;
  try {
    const raw = await readRequestBody(req);
    parsedBody = JSON.parse(raw);
  } catch (err) {
    log(`✗ /command: couldn't parse request body: ${err.message || err}`, "error");
    sendJson(res, 200, { ok: false, error: `Invalid JSON request body: ${err.message || err}` });
    return;
  }

  const { command, payload, requestId } = parsedBody || {};
  if (!command || typeof command !== "string") {
    sendJson(res, 200, { ok: false, requestId, error: "Request body must include a string `command` field." });
    return;
  }

  log(`→ ${command} (requestId=${requestId ?? "n/a"})`, "info");
  const result = await runExtendScriptCommand(command, payload ?? {}, requestId ?? null);
  log(result.ok ? `✓ ${command} succeeded` : `✗ ${command} failed: ${result.error ?? "unknown error"}`, result.ok ? "success" : "error");
  sendJson(res, 200, result);
}

/**
 * Task 4/6: POST /raw-eval { script } -> runs `script` directly via
 * evalScript(), bypassing dispatch()/the JSON request envelope entirely.
 * Body must be `{ "script": "<literal ExtendScript source>" }`.
 */
function rawEvalTransportFailure(script, transportError) {
  return { ok: false, script: script ?? null, rawResult: null, rawResultType: "undefined", rawResultLength: 0, isEvalScriptError: false, transportError };
}

async function handleRawEval(req, res) {
  let rawBody;
  let parsedBody;
  try {
    rawBody = await readRequestBody(req);
    parsedBody = JSON.parse(rawBody);
  } catch (err) {
    log(`✗ /raw-eval: couldn't parse request body: ${err.message || err}. Raw body received: ${JSON.stringify(rawBody)}`, "error");
    sendJson(res, 200, rawEvalTransportFailure(null, `Invalid JSON request body: ${err.message || err}`));
    return;
  }

  const { script } = parsedBody || {};
  // Task 9: verify the route is actually receiving the requested script,
  // not an undefined/wrong body field — logged unconditionally, every call.
  log(`→ /raw-eval received body: ${JSON.stringify(parsedBody)} (script field: ${JSON.stringify(script)})`, "info");
  if (!script || typeof script !== "string") {
    sendJson(res, 200, rawEvalTransportFailure(script ?? null, "Request body must include a string `script` field."));
    return;
  }

  const result = await runRawEvalScript(script);
  log(
    result.ok
      ? "✓ /raw-eval succeeded (raw callback was not the literal \"EvalScript error.\" string)"
      : `✗ /raw-eval failed: ${result.transportError ?? (result.isEvalScriptError ? 'raw callback was the literal "EvalScript error." string' : "unknown")}`,
    result.ok ? "success" : "error"
  );
  sendJson(res, 200, result);
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, extendscriptReady: true });
    return;
  }
  if (req.method === "POST" && req.url === "/command") {
    handleCommand(req, res).catch((err) => {
      log(`✗ /command handler threw: ${err.message || err}`, "error");
      sendJson(res, 200, { ok: false, error: `Bridge handler crashed: ${err.message || err}` });
    });
    return;
  }
  if (req.method === "POST" && req.url === "/raw-eval") {
    handleRawEval(req, res).catch((err) => {
      log(`✗ /raw-eval handler threw: ${err.message || err}`, "error");
      sendJson(res, 200, { ok: false, error: `Bridge handler crashed: ${err.message || err}` });
    });
    return;
  }
  sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${req.url}` });
});

server.on("error", (err) => {
  if (err && err.code === "EADDRINUSE") {
    setStatus(`Port ${PORT} already in use — another instance of this bridge (or something else) is already running.`, false);
    log(`✗ Couldn't start server: port ${PORT} already in use.`, "error");
    return;
  }
  setStatus(`Server error: ${err.message || err}`, false);
  log(`✗ Server error: ${err.message || err}`, "error");
});

/**
 * Task 6: proves — automatically, on every panel load, with no user
 * action required — whether the ExtendScript engine that's actually
 * running has this session's latest hostscript.jsx loaded, or a stale
 * earlier build. Calls "ping" (the oldest, least-likely-to-be-stale
 * command) immediately after the HTTP server starts, and shows the
 * returned hostscriptBuildId/supportedCommands directly in the panel's
 * status line — if this reads an OLD build ID or is missing the newest
 * commands, that alone proves the engine needs Premiere restarted (or the
 * extension reloaded a way that forces ScriptPath re-evaluation), before
 * any command is even attempted from the UXP side.
 */
async function runStartupBuildCheck() {
  log("Checking loaded hostscript.jsx build (startup ping)…", "info");
  const result = await runExtendScriptCommand("ping", {}, "startup-ping");
  if (!result.ok) {
    setStatus(`Bridge is up, but the startup ping to ExtendScript failed: ${result.error ?? "unknown error"}`, false);
    log(`✗ Startup ping failed: ${result.error ?? "unknown error"}`, "error");
    return;
  }
  const buildId = result.result && result.result.hostscriptBuildId;
  const commands = (result.result && result.result.supportedCommands) || [];
  setStatus(`Listening on http://${HOST}:${PORT} — hostscript.jsx build: ${buildId ?? "unknown (pre-build-ID version)"}`, true);
  log(`✓ Loaded hostscript.jsx build: ${buildId ?? "unknown"}. Supported commands: ${commands.join(", ") || "(none reported — pre-build-ID version)"}`, "success");
}

server.listen(PORT, HOST, () => {
  setStatus(`Listening on http://${HOST}:${PORT} — checking hostscript.jsx build…`, true);
  log(`✓ Bridge server started on http://${HOST}:${PORT}`, "success");
  runStartupBuildCheck().catch((err) => {
    log(`✗ Startup build check crashed: ${err.message || err}`, "error");
  });
});
