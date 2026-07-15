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

const PORT = 3010;
const HOST = "127.0.0.1"; // local-only — never bind 0.0.0.0 for a bridge that can execute host scripting.
const EVALSCRIPT_TIMEOUT_MS = 15000;

const csInterface = new CSInterface();

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

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
      resolve({ ok: false, requestId, error: `ExtendScript did not respond within ${EVALSCRIPT_TIMEOUT_MS}ms.` });
    }, EVALSCRIPT_TIMEOUT_MS);

    const requestJson = JSON.stringify({ command, payload, requestId });
    // Double-encode: JSON.stringify(requestJson) turns the JSON string into
    // a safely-escaped JS string literal to embed directly in the
    // evalScript call, so hostscript.jsx's dispatch() receives it as a
    // single string argument and does its own JSON.parse().
    const script = `$._captionStudioBridge.dispatch(${JSON.stringify(requestJson)})`;

    // Task 2: log the exact evalScript source string immediately before
    // calling evalScript() — lets a byte-for-byte comparison between a
    // known-working command's call (e.g. probeSourceTextDeep) and a
    // failing one's (e.g. bisectHostScript/echoPayload) rule in or out any
    // difference in how the call itself is constructed, independent of
    // what's actually loaded in the ExtendScript engine.
    log(`evalScript source for "${command}": ${script}`, "info");

    try {
      csInterface.evalScript(script, (resultString) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutHandle);
        if (resultString === undefined || resultString === null || resultString === "") {
          resolve({ ok: false, requestId, error: "evalScript returned an empty result." });
          return;
        }
        try {
          const parsed = JSON.parse(resultString);
          resolve(parsed);
        } catch (err) {
          // evalScript itself surfaces host-side syntax/runtime errors as
          // a string starting with "EvalScript error" rather than JSON.
          resolve({ ok: false, requestId, error: `Non-JSON response from ExtendScript: ${resultString}`, parseError: String(err.message || err) });
        }
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      resolve({ ok: false, requestId, error: `evalScript threw synchronously: ${err.message || err}` });
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
