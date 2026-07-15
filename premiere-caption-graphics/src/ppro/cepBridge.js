/**
 * UXP-side client for the experimental CEP/ExtendScript write bridge (see
 * ../../cep-bridge/ and ../../docs/CEP_BRIDGE_INVESTIGATION.md). UXP
 * cannot host a server — only act as a network client — so this is
 * deliberately the client half of the pair: the CEP panel
 * (cep-bridge/client/main.js) hosts a small local HTTP server, and this
 * module talks to it via `fetch()`.
 *
 * CONFIRMED PLATFORM LIMITATION (Adobe's own docs): "Premiere disallows
 * http:// URLs on macOS" — this bridge, as built, only works on Windows
 * until the CEP side adds a self-signed HTTPS listener (not yet
 * implemented — see docs/CEP_BRIDGE_INVESTIGATION.md's limitations
 * section). On macOS, every call here will fail with a network error; that
 * failure is reported clearly, not silently swallowed.
 *
 * Every function here returns the same {ok, ...} shape the rest of this
 * project's src/ppro/*.js diagnostics use, and every network call is
 * timeout-guarded via AbortController — the same "never hang, always
 * report exactly what happened" discipline as everywhere else in this
 * codebase.
 */

import { requireActiveProjectAndSequence, listVideoTracks } from "./timelineRange.js";

const CEP_BRIDGE_BASE_URL = "http://localhost:3010";
const DEFAULT_TIMEOUT_MS = 8000;
const HEALTH_CHECK_TIMEOUT_MS = 2000;

export const CEP_WRITE_PROOF_SENTINEL = "__KERIS_CEP_TEST__";

/**
 * Resolve the topmost video track index on the UXP side, matching the
 * convention "the UXP insertion code previously targeted the top video
 * track" — this is the SAME topmost-track convention, just resolved here
 * instead of left hard-coded to 0. Returns `undefined` (not 0, not a
 * guess) when it can't be determined — no active project/sequence, no
 * video tracks, or a thrown error — so the payload simply omits
 * videoTrackIndex and the CEP/ExtendScript side's own independent
 * topmost-track fallback (see cep-bridge/jsx/hostscript.jsx) takes over.
 * Never returns a hard-coded 0.
 *
 * @param {(message: string, level?: string) => void} [log]
 * @returns {Promise<number | undefined>}
 */
export async function resolveTopVideoTrackIndexForCep(log) {
  try {
    const { sequence } = await requireActiveProjectAndSequence();
    const tracks = await listVideoTracks(sequence);
    if (!tracks.length) {
      if (log) log("[cepBridge] No video tracks found on the active sequence — leaving videoTrackIndex unset.", "warn");
      return undefined;
    }
    const topIndex = tracks.length - 1;
    if (log) log(`[cepBridge] Resolved topmost video track for CEP payload → index ${topIndex} (of ${tracks.length}).`, "info");
    return topIndex;
  } catch (err) {
    if (log) log(`[cepBridge] Could not resolve topmost video track: ${err.message || err} — leaving videoTrackIndex unset.`, "warn");
    return undefined;
  }
}

function makeRequestId() {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * POSTs one command to the CEP bridge's /command endpoint and returns its
 * JSON response verbatim (already {ok, requestId, result|error} shaped by
 * the CEP side). Network-level failures (bridge not running, timeout, bad
 * JSON) are normalized into that same shape here, so every caller has one
 * shape to check regardless of what went wrong or where.
 *
 * @param {string} command
 * @param {Object} payload
 * @param {{ timeoutMs?: number, log?: (message: string, level?: string) => void }} [opts]
 */
export async function callCepBridge(command, payload, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, log } = opts;
  const requestId = makeRequestId();

  if (log) log(`[cepBridge] → ${command} (requestId=${requestId})`, "info");

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(`${CEP_BRIDGE_BASE_URL}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command, payload, requestId }),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeoutHandle);
    if (err && err.name === "AbortError") {
      if (log) log(`[cepBridge] ✗ ${command} timed out after ${timeoutMs}ms.`, "error");
      return { ok: false, requestId, step: "timeout", error: `CEP bridge did not respond within ${timeoutMs}ms.` };
    }
    const error =
      `CEP bridge unavailable at ${CEP_BRIDGE_BASE_URL} — is the "Caption Studio CEP Bridge" panel open in Premiere ` +
      `(Window > Extensions)? On macOS this also fails if the bridge hasn't been upgraded to HTTPS yet — see ` +
      `docs/CEP_BRIDGE_INVESTIGATION.md. (${err.message || err})`;
    if (log) log(`[cepBridge] ✗ ${command}: ${error}`, "error");
    return { ok: false, requestId, step: "unreachable", error };
  }
  clearTimeout(timeoutHandle);

  if (!response.ok) {
    const error = `CEP bridge returned HTTP ${response.status}.`;
    if (log) log(`[cepBridge] ✗ ${command}: ${error}`, "error");
    return { ok: false, requestId, step: "http", error };
  }

  let json;
  try {
    json = await response.json();
  } catch (err) {
    const error = `CEP bridge returned a non-JSON response: ${err.message || err}`;
    if (log) log(`[cepBridge] ✗ ${command}: ${error}`, "error");
    return { ok: false, requestId, step: "parse", error };
  }

  if (log) log(json.ok ? `[cepBridge] ✓ ${command} succeeded` : `[cepBridge] ✗ ${command} failed: ${json.error ?? "unknown error"}`, json.ok ? "success" : "error");
  return json;
}

/**
 * Quick GET /health check — used before a real command so the UI can
 * distinguish "the bridge panel isn't open" from "the command itself
 * failed", with a short timeout since this is meant to be a fast,
 * frequent-ish check.
 */
export async function checkCepBridgeHealth() {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), HEALTH_CHECK_TIMEOUT_MS);
  try {
    const response = await fetch(`${CEP_BRIDGE_BASE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeoutHandle);
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
    const json = await response.json();
    return { ok: true, ...json };
  } catch (err) {
    clearTimeout(timeoutHandle);
    return { ok: false, error: err && err.name === "AbortError" ? "timed out" : String(err.message || err) };
  }
}

/**
 * The full proof-of-concept entry point: checks the bridge is reachable,
 * then asks it to import the given .mogrt at the playhead, set its
 * duration, and attempt ComponentParam.setValue() on its Source Text
 * param — the direct ExtendScript equivalent of the UXP
 * createSetValueAction() call that threw "Illegal Parameter type". See
 * cep-bridge/jsx/hostscript.jsx for exactly what runs host-side.
 *
 * Deliberately does NOT clean up the created clip — see
 * cep-bridge/README.md for why.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {string} [opts.sentinel]
 * @param {number} [opts.durationSec]
 * @param {number} [opts.videoTrackIndex]
 * @param {number} [opts.timeoutMs]
 */
export async function testCepWriteProof(opts) {
  const {
    mogrtPath,
    log,
    sentinel = CEP_WRITE_PROOF_SENTINEL,
    durationSec = 2,
    videoTrackIndex,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  log("════ CEP Bridge Write Proof — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const health = await checkCepBridgeHealth();
  if (!health.ok) {
    log(
      `✗ CEP bridge unavailable: ${health.error}. Make sure the "Caption Studio CEP Bridge" CEP panel is open in ` +
        'Premiere (Window > Extensions) — see cep-bridge/README.md for setup.',
      "error"
    );
    return { ok: false, step: "bridge-unavailable", error: health.error };
  }
  log("✓ CEP bridge is reachable.", "success");

  // Never hard-code videoTrackIndex to 0 — on a sequence with many video
  // tracks that's very unlikely to be where the editor wants the caption
  // graphic. Resolve the real topmost video track (the same convention the
  // UXP MOGRT-insertion path already uses) unless the caller passed an
  // explicit index. If resolution fails, omit the field entirely rather
  // than guessing — the ExtendScript side has its own independent
  // topmost-track fallback (see cep-bridge/jsx/hostscript.jsx).
  const resolvedVideoTrackIndex =
    typeof videoTrackIndex === "number" ? videoTrackIndex : await resolveTopVideoTrackIndexForCep(log);

  const payload = { mogrtPath, text: sentinel, durationSec };
  if (typeof resolvedVideoTrackIndex === "number") payload.videoTrackIndex = resolvedVideoTrackIndex;

  const result = await callCepBridge("createTextGraphic", payload, { timeoutMs, log });

  log(result.ok ? "════ CEP Bridge Write Proof — finished ════" : "════ CEP Bridge Write Proof — finished with errors ════", result.ok ? "success" : "error");
  return result;
}

export const CEP_SOURCE_TEXT_PROBE_SENTINEL = "__KERIS_SOURCE_TEXT_PROBE__";

/**
 * Read-before-write investigation of the Source Text ComponentParam: asks
 * the CEP bridge to insert the given .mogrt, dump everything reflect-
 * visible about the Source Text param and getValue()'s return value
 * BEFORE calling setValue(), and only attempt a targeted, evidence-based
 * write (plus a before/after diff) if that dump reveals a genuinely
 * constructible (plain-object or JSON-string) shape with an identifiable
 * text-like field. See cep-bridge/jsx/hostscript.jsx's
 * probeSourceTextDeep() for exactly what runs host-side, and
 * docs/CEP_BRIDGE_INVESTIGATION.md Part 8 for why this exists.
 *
 * Deliberately does NOT clean up the created clip — same rationale as
 * testCepWriteProof(); see cep-bridge/README.md.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {string} [opts.newTextValue]
 * @param {number} [opts.videoTrackIndex]
 * @param {number} [opts.timeoutMs]
 */
export async function probeSourceTextDeep(opts) {
  const {
    mogrtPath,
    log,
    newTextValue = CEP_SOURCE_TEXT_PROBE_SENTINEL,
    videoTrackIndex,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  log("════ CEP Source Text Deep Probe — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const health = await checkCepBridgeHealth();
  if (!health.ok) {
    log(
      `✗ CEP bridge unavailable: ${health.error}. Make sure the "Caption Studio CEP Bridge" CEP panel is open in ` +
        'Premiere (Window > Extensions) — see cep-bridge/README.md for setup.',
      "error"
    );
    return { ok: false, step: "bridge-unavailable", error: health.error };
  }
  log("✓ CEP bridge is reachable.", "success");

  const resolvedVideoTrackIndex =
    typeof videoTrackIndex === "number" ? videoTrackIndex : await resolveTopVideoTrackIndexForCep(log);

  const payload = { mogrtPath, newTextValue };
  if (typeof resolvedVideoTrackIndex === "number") payload.videoTrackIndex = resolvedVideoTrackIndex;

  const result = await callCepBridge("probeSourceTextDeep", payload, { timeoutMs, log });

  log(
    result.ok ? "════ CEP Source Text Deep Probe — finished ════" : "════ CEP Source Text Deep Probe — finished with errors ════",
    result.ok ? "success" : "error"
  );
  return result;
}

/**
 * Byte-level inspection of the exact string getValue() returns for Source
 * Text — built to explain an internally inconsistent real-host result
 * from probeSourceTextDeep() (typeof "string", a preview that LOOKED like
 * "{}", but JSON.parse() failing / structuredKind "none"). Never calls
 * setValue(). See cep-bridge/jsx/hostscript.jsx's
 * inspectSourceTextRawBytes() for exactly what runs host-side (exact
 * length, JSON.stringify(), every character code + hex, first/last 32
 * characters, and JSON.parse() attempts against the raw string plus
 * trimmed/BOM-stripped/null-stripped/fully-normalized variants — each
 * with the exact failure message + position captured), and
 * docs/CEP_BRIDGE_INVESTIGATION.md Part 9 for why this exists.
 *
 * Deliberately does NOT clean up the created clip — same rationale as
 * testCepWriteProof(); see cep-bridge/README.md.
 *
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {number} [opts.videoTrackIndex]
 * @param {boolean} [opts.skipFileSave] — isolates whether temp-file writing
 *   is what's crashing: if the full diagnostic reproduces an "EvalScript
 *   error." but a run with this set to true does not, the fault is in the
 *   File/Folder temp-file write, not the byte/JSON inspection logic itself.
 * @param {number} [opts.timeoutMs]
 */
export async function inspectSourceTextRawBytes(opts) {
  const { mogrtPath, log, videoTrackIndex, skipFileSave, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  log("════ CEP Source Text Raw Byte Inspection — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  const health = await checkCepBridgeHealth();
  if (!health.ok) {
    log(
      `✗ CEP bridge unavailable: ${health.error}. Make sure the "Caption Studio CEP Bridge" CEP panel is open in ` +
        'Premiere (Window > Extensions) — see cep-bridge/README.md for setup.',
      "error"
    );
    return { ok: false, step: "bridge-unavailable", error: health.error };
  }
  log("✓ CEP bridge is reachable.", "success");

  const resolvedVideoTrackIndex =
    typeof videoTrackIndex === "number" ? videoTrackIndex : await resolveTopVideoTrackIndexForCep(log);

  const payload = { mogrtPath };
  if (typeof resolvedVideoTrackIndex === "number") payload.videoTrackIndex = resolvedVideoTrackIndex;
  if (skipFileSave) payload.skipFileSave = true;

  const result = await callCepBridge("inspectSourceTextRawBytes", payload, { timeoutMs, log });

  log(
    result.ok
      ? "════ CEP Source Text Raw Byte Inspection — finished ════"
      : "════ CEP Source Text Raw Byte Inspection — finished with errors ════",
    result.ok ? "success" : "error"
  );
  return result;
}

/**
 * Task 8's standalone diagnostic: exercises inspectSourceTextRawBytes()'s
 * byte/JSON helpers (charCodeHexDump, tryJsonParse, JSON.stringify)
 * against a plain dummy string in ExtendScript — no Premiere host objects
 * touched at all (no project/sequence/MOGRT/ComponentParam). Only checks
 * the CEP bridge is reachable first; does NOT require a .mogrt path, an
 * active project, or an active sequence, since it never uses any of them.
 * See cep-bridge/jsx/hostscript.jsx's testRawBytesHelpers() for exactly
 * what runs host-side, and docs/CEP_BRIDGE_INVESTIGATION.md Part 10 for
 * why this exists (isolating whether an "EvalScript error." on
 * inspectSourceTextRawBytes() comes from the string-processing logic
 * itself versus the MOGRT-insertion/file-I/O path).
 *
 * @param {Object} opts
 * @param {(message: string, level?: string) => void} opts.log
 * @param {string} [opts.testString] — defaults host-side to a string with
 *   a BOM, an embedded null character, and surrounding whitespace around
 *   "{}" — reproducing the real-host anomaly this whole investigation
 *   exists to explain.
 * @param {number} [opts.timeoutMs]
 */
export async function testRawBytesHelpers(opts) {
  const { log, testString, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  log("════ CEP Raw Bytes Helper Self-Test — start ════", "info");

  const health = await checkCepBridgeHealth();
  if (!health.ok) {
    log(
      `✗ CEP bridge unavailable: ${health.error}. Make sure the "Caption Studio CEP Bridge" CEP panel is open in ` +
        'Premiere (Window > Extensions) — see cep-bridge/README.md for setup.',
      "error"
    );
    return { ok: false, step: "bridge-unavailable", error: health.error };
  }
  log("✓ CEP bridge is reachable.", "success");

  const payload = {};
  if (typeof testString === "string") payload.testString = testString;

  const result = await callCepBridge("testRawBytesHelpers", payload, { timeoutMs, log });

  log(
    result.ok ? "════ CEP Raw Bytes Helper Self-Test — finished ════" : "════ CEP Raw Bytes Helper Self-Test — finished with errors ════",
    result.ok ? "success" : "error"
  );
  return result;
}

/**
 * Runs exactly ONE step of the bisectHostScript() host command — see
 * cep-bridge/jsx/hostscript.jsx's bisectHostScript() for the exact
 * progression (0-11), built per the user's explicit instruction to stop
 * adding diagnostics and instead find the precise breaking statement by
 * testing one incremental addition at a time. Never touches app/project/
 * sequence at any step, so — like testRawBytesHelpers() — it doesn't
 * require a .mogrt path, an active project, or an active sequence.
 *
 * @param {Object} opts
 * @param {(message: string, level?: string) => void} opts.log
 * @param {number} opts.step — 0 through 11; see hostscript.jsx for what each step adds.
 * @param {number} [opts.timeoutMs]
 */
export async function bisectHostScript(opts) {
  const { log, step, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;

  log(`════ CEP Bisect — step ${step} — start ════`, "info");

  const health = await checkCepBridgeHealth();
  if (!health.ok) {
    log(
      `✗ CEP bridge unavailable: ${health.error}. Make sure the "Caption Studio CEP Bridge" CEP panel is open in ` +
        'Premiere (Window > Extensions) — see cep-bridge/README.md for setup.',
      "error"
    );
    return { ok: false, step: "bridge-unavailable", error: health.error };
  }
  log("✓ CEP bridge is reachable.", "success");

  const result = await callCepBridge("bisectHostScript", { step }, { timeoutMs, log });

  log(result.ok ? `════ CEP Bisect — step ${step} — finished ════` : `════ CEP Bisect — step ${step} — finished with errors ════`, result.ok ? "success" : "error");
  return result;
}
