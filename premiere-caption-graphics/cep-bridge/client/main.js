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
 *
 * Real-host startup regression this file guards against (see
 * docs/CEP_BRIDGE_INVESTIGATION.md Part 15): a previous version did
 * `require("./rawEvalClassify.cjs")` — requiring a LOCAL project file by
 * relative path — at the very top of this script, before any DOM/status
 * code ran. That broke the CEP panel entirely: whatever went wrong with
 * that require() call threw synchronously, with no try/catch around it,
 * so NONE of this file's code ever ran — not even the first
 * setStatus() call — leaving the panel stuck on index.html's static
 * "Starting…" text forever, with no visible error anywhere. Two changes
 * fix and guard against that class of failure: (1) classifyRawEvalResult
 * is now inlined directly below, not require()'d from a local file — CEP's
 * `--enable-nodejs`/`--mixed-context` Node integration is real Node, but
 * this project has no confirmed-reliable evidence that require()'ing a
 * local project file by relative path from inside a CEP panel actually
 * works, so it's avoided entirely now (only the built-in `http` module is
 * require()'d, which is the same thing this file has always done); (2)
 * this file's entire startup sequence now runs inside one top-level
 * try/catch, so ANY future synchronous failure — a bad require(), a
 * missing DOM element, anything — renders a full, visible error directly
 * in the panel instead of leaving it silently stuck.
 *
 * A separate, byte-for-byte identical copy of classifyRawEvalResult lives
 * in rawEvalClassify.cjs purely so it can be unit-tested under plain Node
 * (test/cepRawEvalClassify.test.js) — that file is NEVER require()'d by
 * this one; test/cepClientMain.test.js has a static regression check
 * confirming that.
 */

// Defined OUTSIDE the try block below, and depends on nothing but
// `document`/`console` (both guaranteed present in a CEP panel's browser
// context regardless of anything else going wrong), so it can render an
// error no matter how early startup fails.
function renderStartupError(err) {
  var message = "STARTUP FAILED: " + (err && err.message ? err.message : String(err));
  var stack = err && err.stack ? String(err.stack) : "(no stack available)";
  // eslint-disable-next-line no-console
  console.error("[CEP Bridge] " + message, err);
  try {
    var statusEl = document.getElementById("status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.style.borderColor = "#e05f5f";
    }
    var logEl = document.getElementById("log");
    if (logEl) {
      var line = document.createElement("div");
      line.textContent = message + "\n" + stack;
      line.style.color = "#e05f5f";
      line.style.whiteSpace = "pre-wrap";
      logEl.appendChild(line);
    }
  } catch (renderErr) {
    // eslint-disable-next-line no-console
    console.error("[CEP Bridge] renderStartupError() itself failed:", renderErr);
  }
}

// Task 3: the ENTIRE browser-side startup sequence below runs inside one
// top-level try/catch — see the header comment above for why.
try {
  if (typeof document === "undefined" || !document.getElementById("status")) {
    throw new Error('Loading client script: #status element not found in index.html — is main.js loaded from the right page?');
  }
  var statusEl = document.getElementById("status");
  statusEl.textContent = "Loading client script…"; // stage 1 (task 2)

  // eslint-disable-next-line no-undef
  const http = require("http");

  const PORT = 3010;
  const HOST = "127.0.0.1"; // local-only — never bind 0.0.0.0 for a bridge that can execute host scripting.
  const EVALSCRIPT_TIMEOUT_MS = 15000;

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

  setStatus("Loading classifier…", true); // stage 2 (task 2)
  log("Loading classifier (inlined directly in main.js — no require() of a local file)…", "info");

  // Tasks 4/5/6: classifyRawEvalResult, inlined directly here rather than
  // require()'d — see this file's header comment for why. Pure
  // classification logic for a raw CSInterface.evalScript() callback
  // result: `ok` is false ONLY when the callback is EXACTLY the literal
  // "EvalScript error." string — never because the text "isn't JSON"
  // (most bypass test scripts intentionally don't return JSON at all).
  // KEEP THIS IN SYNC with rawEvalClassify.cjs's identically-named
  // function — test/cepClientMain.test.js checks both copies stay
  // byte-for-byte identical.
  function classifyRawEvalResult(resultString) {
    const rawResultType = typeof resultString;
    const rawResult = resultString === undefined ? null : resultString;
    const rawResultLength = rawResult === null ? 0 : String(rawResult).length;
    const isEvalScriptError = resultString === "EvalScript error.";
    return { ok: !isEvalScriptError, rawResult, rawResultType, rawResultLength, isEvalScriptError };
  }

  const csInterface = new CSInterface();

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

  setStatus("Starting HTTP server…", true); // stage 3 (task 2)
  log("Starting HTTP server…", "info");

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
    setStatus(`Listening on http://${HOST}:${PORT} — checking hostscript.jsx build…`, true); // stage 4 (task 2)
    log(`✓ Bridge server started on http://${HOST}:${PORT}`, "success");
    runStartupBuildCheck().catch((err) => {
      log(`✗ Startup build check crashed: ${err.message || err}`, "error");
    });
  });
} catch (err) {
  renderStartupError(err);
}
