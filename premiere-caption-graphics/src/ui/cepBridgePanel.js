import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import {
  testCepWriteProof,
  probeSourceTextDeep,
  inspectSourceTextRawBytes,
  testRawBytesHelpers,
  bisectHostScript,
  getAvailableCommands,
  echoPayload,
  runRawEvalScript,
  checkCepBridgeHealth,
  BYPASS_TEST_SCRIPTS,
  CEP_WRITE_PROOF_SENTINEL,
  CEP_SOURCE_TEXT_PROBE_SENTINEL,
} from "../ppro/cepBridge.js";

// Confirmed on a live host (docs/CEP_BRIDGE_INVESTIGATION.md Part 17): even
// `app.name` — a built-in ExtendScript global with zero dependency on this
// project's own code, hostscript.jsx, or $._captionStudioBridge — returns
// the literal "EvalScript error." via CSInterface.evalScript(). This is a
// fixed, confirmed finding, not a live re-check: CEP ExtendScript execution
// is unavailable in this Premiere host version. Do not turn this back into
// a live probe — see Part 17 for why bisecting this further isn't useful.
const CEP_EXTENDSCRIPT_UNAVAILABLE_MESSAGE = "Premiere's CEP ExtendScript engine is unavailable in this host version.";

const BISECT_MAX_STEP = 11;

function patchCepBridge(patch) {
  store.set((s) => ({ cepBridge: { ...s.cepBridge, ...patch } }));
}

// Reuses the existing GET /health plumbing (checkCepBridgeHealth(), already
// used before every command) purely to report CEP-server reachability as a
// status line — this is not a new diagnostic, and it never touches
// ExtendScript/hostscript.jsx/Source Text.
async function runHostCompatibilityCheck() {
  patchCepBridge({ hostStatus: { ...store.getState().cepBridge.hostStatus, checking: true } });
  try {
    const health = await checkCepBridgeHealth();
    patchCepBridge({
      hostStatus: { checking: false, cepServerAvailable: health.ok === true, lastCheckedAt: Date.now() },
    });
  } catch (err) {
    log(`Host compatibility check crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({
      hostStatus: { checking: false, cepServerAvailable: false, lastCheckedAt: Date.now() },
    });
  }
}

async function runBuildCheck() {
  patchCepBridge({ buildCheckRunning: true, lastBuildCheckResult: null });
  try {
    const result = await getAvailableCommands({ log });
    console.error("[Caption Graphics Studio] CEP getAvailableCommands result:", JSON.stringify(result, null, 2));
    patchCepBridge({ lastBuildCheckResult: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] CEP getAvailableCommands crashed:", err);
    log(`CEP getAvailableCommands crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastBuildCheckResult: { ok: false, step: "crash" } });
  } finally {
    patchCepBridge({ buildCheckRunning: false });
  }
}

async function runEchoPayload() {
  const { echoTestValue } = store.getState().cepBridge;
  patchCepBridge({ echoRunning: true, lastEchoResult: null });
  try {
    const result = await echoPayload({ log, payload: { testValue: echoTestValue } });
    console.error("[Caption Graphics Studio] CEP echoPayload result:", JSON.stringify(result, null, 2));
    patchCepBridge({ lastEchoResult: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] CEP echoPayload crashed:", err);
    log(`CEP echoPayload crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastEchoResult: { ok: false, step: "crash" } });
  } finally {
    patchCepBridge({ echoRunning: false });
  }
}

async function runBypassTest(key) {
  const scriptEntry = BYPASS_TEST_SCRIPTS[key];
  if (!scriptEntry) return;
  patchCepBridge({
    bypassRunning: { ...store.getState().cepBridge.bypassRunning, [key]: true },
    lastBypassResults: { ...store.getState().cepBridge.lastBypassResults, [key]: null },
  });
  try {
    const result = await runRawEvalScript({ script: scriptEntry.script, log });
    console.error(`[Caption Graphics Studio] CEP bypass test "${key}" result:`, JSON.stringify(result, null, 2));
    patchCepBridge({ lastBypassResults: { ...store.getState().cepBridge.lastBypassResults, [key]: result } });
  } catch (err) {
    console.error(`[Caption Graphics Studio] CEP bypass test "${key}" crashed:`, err);
    log(`CEP bypass test "${key}" crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastBypassResults: { ...store.getState().cepBridge.lastBypassResults, [key]: { ok: false, step: "crash" } } });
  } finally {
    patchCepBridge({ bypassRunning: { ...store.getState().cepBridge.bypassRunning, [key]: false } });
  }
}

async function pickMogrt() {
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["mogrt"] });
    if (!file) return;
    patchCepBridge({ mogrtPath: file.nativePath, lastResult: null });
    log(`Template chosen for CEP write proof: ${file.nativePath}`, "info");
  } catch (err) {
    log(`Couldn't pick a .mogrt file: ${err.message || err}`, "error");
  }
}

async function runWriteProof() {
  const { mogrtPath } = store.getState().cepBridge;
  if (!mogrtPath) {
    log("Choose a .mogrt to test first.", "error");
    return;
  }
  patchCepBridge({ running: true, lastResult: null });
  try {
    const result = await testCepWriteProof({ mogrtPath, log });
    console.error("[Caption Graphics Studio] CEP Bridge Write Proof result:", JSON.stringify(result, null, 2));
    patchCepBridge({ lastResult: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] CEP Bridge Write Proof crashed:", err);
    log(`CEP Bridge Write Proof crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastResult: { ok: false, step: "crash" } });
  } finally {
    patchCepBridge({ running: false });
  }
}

async function runSourceTextProbe() {
  const { mogrtPath } = store.getState().cepBridge;
  if (!mogrtPath) {
    log("Choose a .mogrt to probe first.", "error");
    return;
  }
  patchCepBridge({ probeRunning: true, lastProbeResult: null });
  try {
    const result = await probeSourceTextDeep({ mogrtPath, log });
    console.error("[Caption Graphics Studio] CEP Source Text Deep Probe result:", JSON.stringify(result, null, 2));
    patchCepBridge({ lastProbeResult: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] CEP Source Text Deep Probe crashed:", err);
    log(`CEP Source Text Deep Probe crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastProbeResult: { ok: false, step: "crash" } });
  } finally {
    patchCepBridge({ probeRunning: false });
  }
}

async function runRawBytesInspection() {
  const { mogrtPath, skipFileSave } = store.getState().cepBridge;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchCepBridge({ rawBytesRunning: true, lastRawBytesResult: null });
  try {
    const result = await inspectSourceTextRawBytes({ mogrtPath, log, skipFileSave });
    console.error("[Caption Graphics Studio] CEP Source Text Raw Byte Inspection result:", JSON.stringify(result, null, 2));
    patchCepBridge({ lastRawBytesResult: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] CEP Source Text Raw Byte Inspection crashed:", err);
    log(`CEP Source Text Raw Byte Inspection crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastRawBytesResult: { ok: false, step: "crash" } });
  } finally {
    patchCepBridge({ rawBytesRunning: false });
  }
}

async function runRawBytesHelperSelfTest() {
  patchCepBridge({ selfTestRunning: true, lastSelfTestResult: null });
  try {
    const result = await testRawBytesHelpers({ log });
    console.error("[Caption Graphics Studio] CEP Raw Bytes Helper Self-Test result:", JSON.stringify(result, null, 2));
    patchCepBridge({ lastSelfTestResult: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] CEP Raw Bytes Helper Self-Test crashed:", err);
    log(`CEP Raw Bytes Helper Self-Test crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastSelfTestResult: { ok: false, step: "crash" } });
  } finally {
    patchCepBridge({ selfTestRunning: false });
  }
}

async function runBisectStep() {
  const { bisectStep } = store.getState().cepBridge;
  patchCepBridge({ bisectRunning: true, lastBisectResult: null });
  try {
    const result = await bisectHostScript({ log, step: bisectStep });
    console.error(`[Caption Graphics Studio] CEP Bisect step ${bisectStep} result:`, JSON.stringify(result, null, 2));
    patchCepBridge({ lastBisectResult: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] CEP Bisect crashed:", err);
    log(`CEP Bisect crashed unexpectedly: ${err.message || err}`, "error");
    patchCepBridge({ lastBisectResult: { ok: false, step: "crash" } });
  } finally {
    patchCepBridge({ bisectRunning: false });
  }
}

function diagnosticsBlock(diagnostics) {
  if (!Array.isArray(diagnostics) || !diagnostics.length) return null;
  return el("details", { class: "status-line" }, [
    el("summary", { text: `Diagnostics (${diagnostics.length} step${diagnostics.length === 1 ? "" : "s"})` }),
    el(
      "pre",
      { class: "diagnostics-log" },
      [diagnostics.join("\n")]
    ),
  ]);
}

function resultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    const lines = [
      el("div", { class: "status-line log-error", text: `✗ CEP Bridge Write Proof failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
    ];
    if (Array.isArray(result.beforeClipCounts) || Array.isArray(result.afterClipCounts)) {
      lines.push(
        el("div", {
          class: "status-line",
          text: `Clip counts per video track — before: [${(result.beforeClipCounts ?? []).join(", ")}], after: [${(result.afterClipCounts ?? []).join(", ")}].`,
        })
      );
    }
    const diag = diagnosticsBlock(result.diagnostics);
    if (diag) lines.push(diag);
    return el("div", { class: "inspector-results" }, lines);
  }
  const r = result.result ?? {};
  const lines = [
    el("div", { class: "status-line log-success", text: `✓ Clip created: "${r.trackItemName ?? "n/a"}" at ${typeof r.start === "number" ? r.start.toFixed(3) : "n/a"}s.` }),
    el("div", {
      class: "status-line",
      text:
        `Detected on video track ${r.detectedTrackIndex ?? "unknown"} via "${r.detectionMethod ?? "n/a"}" ` +
        `(importMGT() returned type: ${r.importReturnType ?? "n/a"}; requested video=${r.requestedVideoTrackIndex ?? "n/a"}, audio=${r.requestedAudioTrackIndex ?? "n/a"}).`,
    }),
    el("div", {
      class: `status-line ${r.durationSetOk ? "log-success" : "log-warn"}`,
      text: r.durationSetOk
        ? `✓ Duration set: end = ${typeof r.end === "number" ? r.end.toFixed(3) : "n/a"}s.`
        : `⚠ Duration not set: ${r.durationSetError ?? "unknown error"}`,
    }),
  ];
  if (!r.sourceTextFound) {
    lines.push(el("div", { class: "status-line log-warn", text: "⚠ No \"Source Text\" param was found on this clip's components." }));
  } else {
    lines.push(
      el("div", {
        class: "status-line",
        text: `Source Text found on "${r.componentDisplayName ?? "n/a"}" (isTimeVarying: ${String(r.isTimeVarying)}, areKeyframesSupported: ${String(r.areKeyframesSupported)}).`,
      }),
      el("div", {
        class: `status-line ${r.sourceTextWriteOk ? "log-success" : "log-error"}`,
        text: r.sourceTextWriteOk
          ? `✓ ComponentParam.setValue("${CEP_WRITE_PROOF_SENTINEL}", true) SUCCEEDED — this is the decisive result.`
          : `✗ ComponentParam.setValue() threw: ${r.sourceTextWriteError ?? "unknown error"}`,
      })
    );
    if (r.sourceTextReadBack !== undefined) {
      lines.push(el("div", { class: "status-line", text: `Best-effort read-back (getValue(), not authoritative): ${JSON.stringify(r.sourceTextReadBack)}` }));
    } else if (r.sourceTextReadBackError) {
      lines.push(el("div", { class: "status-line log-warn", text: `Read-back attempt failed: ${r.sourceTextReadBackError}` }));
    }
  }
  lines.push(
    el("div", {
      class: "status-line",
      text: "This clip was NOT auto-removed — check the Premiere timeline directly to visually confirm, then delete it by hand. See cep-bridge/README.md.",
    })
  );
  const diag = diagnosticsBlock(r.diagnostics);
  if (diag) lines.push(diag);
  return el("div", { class: "inspector-results" }, lines);
}

function jsonDetailsBlock(summaryText, value) {
  if (value === undefined) return null;
  return el("details", { class: "status-line" }, [
    el("summary", { text: summaryText }),
    el("pre", { class: "diagnostics-log" }, [JSON.stringify(value, null, 2)]),
  ]);
}

function probeResultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    const lines = [
      el("div", { class: "status-line log-error", text: `✗ Source Text Deep Probe failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
    ];
    if (Array.isArray(result.beforeClipCounts) || Array.isArray(result.afterClipCounts)) {
      lines.push(
        el("div", {
          class: "status-line",
          text: `Clip counts per video track — before: [${(result.beforeClipCounts ?? []).join(", ")}], after: [${(result.afterClipCounts ?? []).join(", ")}].`,
        })
      );
    }
    const diag = diagnosticsBlock(result.diagnostics);
    if (diag) lines.push(diag);
    return el("div", { class: "inspector-results" }, lines);
  }

  const r = result.result ?? {};
  const lines = [
    el("div", {
      class: "status-line log-success",
      text: `✓ Clip created: "${r.trackItemName ?? "n/a"}" on video track ${r.detectedTrackIndex ?? "unknown"} via "${r.detectionMethod ?? "n/a"}".`,
    }),
  ];

  if (!r.sourceTextFound) {
    lines.push(
      el("div", { class: "status-line log-warn", text: '⚠ No "Source Text" param was found on this clip\'s components.' }),
      el("div", { class: "status-line", text: `Component/param names seen: ${JSON.stringify(r.componentAndParamNamesSeen ?? [])}` })
    );
    const diag0 = diagnosticsBlock(r.diagnostics);
    if (diag0) lines.push(diag0);
    return el("div", { class: "inspector-results" }, lines);
  }

  lines.push(el("div", { class: "status-line", text: `Source Text param located on component "${r.componentDisplayName ?? "n/a"}".` }));

  if (r.getValueThrew) {
    lines.push(
      el("div", {
        class: "status-line log-error",
        text: `✗ getValue() THREW at: ${r.getValueThrowLocation ?? "n/a"} — ${r.getValueError ?? "unknown error"}${r.getValueErrorLine != null ? ` (line ${r.getValueErrorLine})` : ""}`,
      })
    );
    const diagT = diagnosticsBlock(r.diagnostics);
    if (diagT) lines.push(diagT);
    return el("div", { class: "inspector-results" }, lines);
  }

  lines.push(
    el("div", {
      class: "status-line",
      text: `getValue() succeeded — typeof result: "${r.getValueRawType ?? "n/a"}". Structured shape: "${r.structuredKind ?? "n/a"}".`,
    })
  );

  const paramDump = jsonDetailsBlock("Full ComponentParam dump (via ExtendScript .reflect)", r.paramDump);
  if (paramDump) lines.push(paramDump);
  const valueDump = jsonDetailsBlock("Full getValue() result dump", r.getValueDump);
  if (valueDump) lines.push(valueDump);

  if (Array.isArray(r.textFieldCandidates)) {
    lines.push(
      el("div", {
        class: "status-line",
        text:
          r.textFieldCandidates.length > 0
            ? `Text-like field candidates: ${r.textFieldCandidates.map((c) => `${c.path} = ${c.valuePreview}`).join(", ")}`
            : "No text-like field candidates found in the structured value.",
      })
    );
  }

  if (r.chosenWriteFieldPath) {
    lines.push(
      el("div", { class: "status-line", text: `Chosen field for the write test: "${r.chosenWriteFieldPath}" → "${CEP_SOURCE_TEXT_PROBE_SENTINEL}".` }),
      el("div", {
        class: `status-line ${r.sourceTextWriteOk ? "log-success" : "log-error"}`,
        text: r.sourceTextWriteOk
          ? "✓ setValue() with the modified structured value SUCCEEDED — this is the decisive result."
          : `✗ setValue() threw: ${r.sourceTextWriteError ?? "unknown error"}${r.sourceTextWriteErrorLine != null ? ` (line ${r.sourceTextWriteErrorLine})` : ""}`,
      })
    );
    if (r.readBackThrew) {
      lines.push(el("div", { class: "status-line log-warn", text: `Post-write read-back threw at: ${r.readBackThrowLocation} — ${r.readBackError}` }));
    } else if (Array.isArray(r.beforeAfterDiff)) {
      lines.push(
        el("div", {
          class: "status-line",
          text: r.beforeAfterDiff.length > 0 ? `Before/after diff: ${r.beforeAfterDiff.length} differing value(s).` : "Before/after diff: no differences detected.",
        })
      );
      const diffBlock = jsonDetailsBlock("Full before/after diff", r.beforeAfterDiff);
      if (diffBlock) lines.push(diffBlock);
      const afterDump = jsonDetailsBlock("Full getValue() result dump (after write)", r.getValueDumpAfter);
      if (afterDump) lines.push(afterDump);
    }
  } else {
    lines.push(el("div", { class: "status-line log-warn", text: "No write test was attempted — see diagnostics for why (unstructured shape or no text-like field found)." }));
  }

  lines.push(
    el("div", {
      class: "status-line",
      text: "This clip was NOT auto-removed — check the Premiere timeline directly to visually confirm, then delete it by hand. See cep-bridge/README.md.",
    })
  );
  const diag = diagnosticsBlock(r.diagnostics);
  if (diag) lines.push(diag);
  return el("div", { class: "inspector-results" }, lines);
}

function fatalStageBlock(r) {
  if (!r || !r.stage) return null;
  return el("div", { class: "inspector-results" }, [
    el("div", { class: "status-line log-error", text: `✗ FATAL at stage "${r.stage}": ${r.error ?? "unknown error"}` }),
    el("div", {
      class: "status-line",
      text: `errorLine: ${r.errorLine ?? "n/a"}, errorFileName: ${r.errorFileName ?? "n/a"}`,
    }),
    r.errorStack ? el("details", { class: "status-line" }, [el("summary", { text: "errorStack" }), el("pre", { class: "diagnostics-log" }, [r.errorStack])]) : null,
    diagnosticsBlock(r.diagnostics),
  ]);
}

function rawBytesResultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    const lines = [
      el("div", { class: "status-line log-error", text: `✗ Source Text Raw Byte Inspection failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
    ];
    if (Array.isArray(result.beforeClipCounts) || Array.isArray(result.afterClipCounts)) {
      lines.push(
        el("div", {
          class: "status-line",
          text: `Clip counts per video track — before: [${(result.beforeClipCounts ?? []).join(", ")}], after: [${(result.afterClipCounts ?? []).join(", ")}].`,
        })
      );
    }
    if (result.stage) {
      lines.push(
        el("div", { class: "status-line log-error", text: `FATAL at stage "${result.stage}".` }),
        el("div", { class: "status-line", text: `errorLine: ${result.errorLine ?? "n/a"}, errorFileName: ${result.errorFileName ?? "n/a"}` })
      );
      if (result.errorStack) {
        lines.push(el("details", { class: "status-line" }, [el("summary", { text: "errorStack" }), el("pre", { class: "diagnostics-log" }, [result.errorStack])]));
      }
    }
    const diag = diagnosticsBlock(result.diagnostics);
    if (diag) lines.push(diag);
    return el("div", { class: "inspector-results" }, lines);
  }

  const r = result.result ?? {};
  const lines = [
    el("div", {
      class: "status-line log-success",
      text: `✓ Clip created: "${r.trackItemName ?? "n/a"}" on video track ${r.detectedTrackIndex ?? "unknown"} via "${r.detectionMethod ?? "n/a"}".`,
    }),
  ];

  if (!r.sourceTextFound) {
    lines.push(el("div", { class: "status-line log-warn", text: '⚠ No "Source Text" param was found on this clip\'s components.' }));
    const diag0 = diagnosticsBlock(r.diagnostics);
    if (diag0) lines.push(diag0);
    return el("div", { class: "inspector-results" }, lines);
  }

  if (r.getValueThrew) {
    lines.push(
      el("div", {
        class: "status-line log-error",
        text: `✗ getValue() THREW at: ${r.getValueThrowLocation ?? "n/a"} — ${r.getValueError ?? "unknown error"}${r.getValueErrorLine != null ? ` (line ${r.getValueErrorLine})` : ""}`,
      })
    );
    const diagT = diagnosticsBlock(r.diagnostics);
    if (diagT) lines.push(diagT);
    return el("div", { class: "inspector-results" }, lines);
  }

  lines.push(el("div", { class: "status-line", text: `getValue() typeof: "${r.getValueRawType ?? "n/a"}".` }));

  if (r.getValueRawType !== "string") {
    lines.push(
      el("div", {
        class: "status-line log-warn",
        text: `getValue() did not return a string — byte-level analysis skipped. Value: ${r.nonStringJsonStringify ?? "n/a"}`,
      })
    );
    const diagNs = diagnosticsBlock(r.diagnostics);
    if (diagNs) lines.push(diagNs);
    return el("div", { class: "inspector-results" }, lines);
  }

  lines.push(
    el("div", { class: "status-line", text: `Raw string length: ${r.rawStringLength ?? "n/a"}.` }),
    el("div", { class: "status-line", text: `JSON.stringify(rawValue): ${r.jsonStringifyOfRawValue ?? "n/a"}` }),
    el("div", { class: "status-line", text: `First 32 chars: ${JSON.stringify(r.first32 ?? "")} | Last 32 chars: ${JSON.stringify(r.last32 ?? "")}` }),
    el("div", {
      class: "status-line",
      text: `Has UTF-8 BOM: ${String(r.hasUtf8Bom)}. Has null character(s): ${String(r.hasNullCharacters)}.`,
    })
  );

  const charDump = jsonDetailsBlock(
    `Full character code dump (${r.charCodeDump?.length ?? 0} char(s)${r.charCodeDumpTruncated ? ", truncated" : ""})`,
    r.charCodeDump
  );
  if (charDump) lines.push(charDump);

  if (Array.isArray(r.jsonParseAttempts)) {
    lines.push(
      el(
        "div",
        { class: "status-line" },
        [
          "JSON.parse() attempts: " +
            r.jsonParseAttempts
              .map((a) => `${a.label}=${a.ok ? "OK" : `FAIL(${a.error}${a.errorPosition != null ? ` @${a.errorPosition}` : ""})`}`)
              .join("; "),
        ]
      ),
      el("div", {
        class: `status-line ${r.isValidJsonAfterNormalization ? "log-success" : "log-warn"}`,
        text: r.isValidJsonAfterNormalization
          ? "✓ Valid JSON after full normalization (BOM-stripped + null-stripped + trimmed)."
          : "✗ Still not valid JSON even after full normalization.",
      })
    );
    const attemptsDump = jsonDetailsBlock("Full JSON.parse() attempts (all 5)", r.jsonParseAttempts);
    if (attemptsDump) lines.push(attemptsDump);
  }

  if (r.savedDiagnosticFile) {
    lines.push(
      el("div", {
        class: `status-line ${r.savedDiagnosticFile.ok ? "log-success" : "log-warn"}`,
        text: r.savedDiagnosticFile.ok
          ? `✓ Full diagnostic saved to: ${r.savedDiagnosticFile.path}`
          : `⚠ Could not save diagnostic file: ${r.savedDiagnosticFile.error}`,
      })
    );
  }

  lines.push(
    el("div", {
      class: "status-line",
      text: "This clip was NOT auto-removed — check the Premiere timeline directly to visually confirm, then delete it by hand. See cep-bridge/README.md.",
    })
  );
  const diag = diagnosticsBlock(r.diagnostics);
  if (diag) lines.push(diag);
  return el("div", { class: "inspector-results" }, lines);
}

function selfTestResultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    if (result.stage) return fatalStageBlock(result);
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Raw Bytes Helper Self-Test failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
      diagnosticsBlock(result.diagnostics),
    ]);
  }

  const r = result.result ?? {};
  const lines = [
    el("div", { class: "status-line log-success", text: `✓ Self-test completed — no Premiere host objects touched. Test string length: ${r.rawStringLength ?? "n/a"}.` }),
    el("div", { class: "status-line", text: `JSON.stringify(testString): ${r.jsonStringifyOfRawValue ?? "n/a"}` }),
    el("div", {
      class: "status-line",
      text: `Has UTF-8 BOM: ${String(r.hasUtf8Bom)}. Has null character(s): ${String(r.hasNullCharacters)}.`,
    }),
  ];
  const charDump = jsonDetailsBlock(`Full character code dump (${r.charCodeDump?.length ?? 0} char(s))`, r.charCodeDump);
  if (charDump) lines.push(charDump);
  if (Array.isArray(r.jsonParseAttempts)) {
    lines.push(
      el(
        "div",
        { class: "status-line" },
        [
          "JSON.parse() attempts: " +
            r.jsonParseAttempts
              .map((a) => `${a.label}=${a.ok ? "OK" : `FAIL(${a.error}${a.errorPosition != null ? ` @${a.errorPosition}` : ""})`}`)
              .join("; "),
        ]
      ),
      el("div", {
        class: `status-line ${r.isValidJsonAfterNormalization ? "log-success" : "log-warn"}`,
        text: r.isValidJsonAfterNormalization ? "✓ Valid JSON after full normalization." : "✗ Still not valid JSON even after full normalization.",
      })
    );
  }
  const diag = diagnosticsBlock(r.diagnostics);
  if (diag) lines.push(diag);
  return el("div", { class: "inspector-results" }, lines);
}

function bisectResultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    if (result.stage) return fatalStageBlock(result);
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Bisect step failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
    ]);
  }
  const r = result.result ?? {};
  return el("div", { class: "inspector-results" }, [
    el("div", { class: "status-line log-success", text: `✓ Step ${r.step ?? "?"} succeeded: "${r.stepName ?? "n/a"}".` }),
    jsonDetailsBlock("Full step result", r),
  ]);
}

function buildCheckResultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Build check failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
    ]);
  }
  const r = result.result ?? {};
  const commands = Array.isArray(r.supportedCommands) ? r.supportedCommands : [];
  const expected = ["ping", "getAvailableCommands", "echoPayload", "createTextGraphic", "probeSourceTextDeep", "inspectSourceTextRawBytes", "testRawBytesHelpers", "bisectHostScript"];
  const missing = expected.filter((c) => !commands.includes(c));
  return el("div", { class: "inspector-results" }, [
    el("div", { class: "status-line log-success", text: `✓ Loaded hostscript.jsx build: "${r.hostscriptBuildId ?? "unknown (pre-build-ID version)"}".` }),
    el("div", { class: "status-line", text: `Supported commands (${commands.length}): ${commands.join(", ") || "(none reported)"}` }),
    el("div", {
      class: `status-line ${missing.length ? "log-error" : "log-success"}`,
      text: missing.length
        ? `✗ MISSING from the loaded engine: ${missing.join(", ")} — the live ExtendScript engine has a STALE build. Restart Premiere Pro (see docs/CEP_BRIDGE_INVESTIGATION.md Part 12) to force it to reload hostscript.jsx.`
        : "✓ All expected commands are present in the loaded engine — this is not a stale-build issue.",
    }),
  ]);
}

function echoResultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    if (result.stage) return fatalStageBlock(result);
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ echoPayload failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
    ]);
  }
  const r = result.result ?? {};
  return el("div", { class: "inspector-results" }, [
    el("div", { class: "status-line log-success", text: "✓ echoPayload succeeded — the minimal, ping-like registration pattern works." }),
    el("div", { class: "status-line", text: `Build: "${r.hostscriptBuildId ?? "n/a"}". Received back: ${JSON.stringify(r.received)}` }),
  ]);
}

function bypassResultBlock(result) {
  if (!result) return null;
  // Task 7: show rawResult, rawResultType, rawResultLength,
  // isEvalScriptError, and any transport error — always, regardless of
  // `ok`, since `transportError` (a real network/bridge-layer failure)
  // and `isEvalScriptError` (the raw callback was literally
  // "EvalScript error.") are two DIFFERENT failure modes that must stay
  // visibly distinct, not collapsed into one generic "failed" line.
  const lines = [
    el("div", { class: "status-line", text: `evalScript source: ${result.script ?? "n/a"}` }),
  ];
  if (result.transportError) {
    lines.push(el("div", { class: "status-line log-error", text: `✗ Transport error (network/bridge layer, not ExtendScript): ${result.transportError}` }));
  } else {
    lines.push(
      el("div", { class: "status-line", text: `rawResult: ${JSON.stringify(result.rawResult)}` }),
      el("div", { class: "status-line", text: `rawResultType: ${result.rawResultType ?? "n/a"}, rawResultLength: ${result.rawResultLength ?? "n/a"}` }),
      el("div", {
        class: `status-line ${result.isEvalScriptError ? "log-error" : "log-success"}`,
        text: result.isEvalScriptError
          ? '✗ isEvalScriptError: true — raw callback IS the literal "EvalScript error." string — this exact layer is where it breaks.'
          : '✓ isEvalScriptError: false — raw callback is NOT the literal "EvalScript error." string.',
      })
    );
  }
  return el("div", { class: "inspector-results" }, lines);
}

// docs/CEP_BRIDGE_INVESTIGATION.md Part 17: a permanent status banner, not a
// diagnostic tool. UXP availability and CEP-server reachability are the only
// two lines that reflect a live check (isHosted() / the existing /health
// endpoint) — CEP ExtendScript is reported unavailable unconditionally,
// since that is now a confirmed live-host finding, not something to keep
// re-probing.
function hostCompatibilityStatusBlock(cb, onChange) {
  const uxpAvailable = isHosted();
  const { checking, cepServerAvailable, lastCheckedAt } = cb.hostStatus;
  const cepServerLabel = checking ? "checking…" : cepServerAvailable === true ? "available" : cepServerAvailable === false ? "unavailable" : "not checked yet";
  const checkedSuffix = lastCheckedAt ? ` (last checked ${new Date(lastCheckedAt).toLocaleTimeString()})` : "";
  const checkBtn = el("button", {
    class: "btn",
    text: checking ? "Checking…" : "Check CEP Server Reachability",
    disabled: checking || undefined,
    onClick: async () => {
      await runHostCompatibilityCheck();
      onChange();
    },
  });
  return el("div", { class: "inspector-results host-compat-status" }, [
    el("h3", { text: "Host Compatibility Status" }),
    el("div", { class: `status-line ${uxpAvailable ? "log-success" : "log-error"}`, text: `${uxpAvailable ? "✓" : "✗"} UXP: ${uxpAvailable ? "available" : "not running inside a UXP host"}` }),
    el("div", {
      class: `status-line ${cepServerAvailable === true ? "log-success" : cepServerAvailable === false ? "log-error" : ""}`,
      text: `${cepServerAvailable === true ? "✓" : cepServerAvailable === false ? "✗" : "•"} CEP server: ${cepServerLabel}${checkedSuffix}`,
    }),
    el("div", {
      class: "status-line log-error",
      text:
        '✗ CEP ExtendScript: unavailable — confirmed on a live host. app.name (a built-in ExtendScript global, zero ' +
        'dependency on this project\'s code) returns the literal "EvalScript error." via CSInterface.evalScript(). ' +
        "See docs/CEP_BRIDGE_INVESTIGATION.md Part 17.",
    }),
    el("div", { class: "row" }, [checkBtn]),
    el("p", { class: "hint" }, [CEP_EXTENDSCRIPT_UNAVAILABLE_MESSAGE]),
  ]);
}

export function renderCepBridgePanel(onChange) {
  const state = store.getState();
  const cb = state.cepBridge;

  const buildCheckBtn = el("button", {
    class: "btn btn-primary",
    text: cb.buildCheckRunning ? "Checking…" : "Check Bridge Build & Commands",
    disabled: !isHosted() || cb.buildCheckRunning || undefined,
    onClick: async () => {
      await runBuildCheck();
      onChange();
    },
  });
  const echoInput = el("input", { type: "text" });
  echoInput.value = cb.echoTestValue;
  echoInput.addEventListener("change", () => {
    patchCepBridge({ echoTestValue: echoInput.value });
    onChange();
  });
  const echoBtn = el("button", {
    class: "btn",
    text: cb.echoRunning ? "Echoing…" : "Run echoPayload Test",
    disabled: !isHosted() || cb.echoRunning || undefined,
    onClick: async () => {
      await runEchoPayload();
      onChange();
    },
  });

  const bypassRows = Object.keys(BYPASS_TEST_SCRIPTS).map((key) => {
    const entry = BYPASS_TEST_SCRIPTS[key];
    const running = Boolean(cb.bypassRunning[key]);
    const btn = el("button", {
      class: "btn",
      text: running ? "Running…" : `Run: ${entry.label}`,
      disabled: !isHosted() || running || undefined,
      onClick: async () => {
        await runBypassTest(key);
        onChange();
      },
    });
    return el("div", { class: "bypass-test-row" }, [
      el("div", { class: "row" }, [btn]),
      el("div", { class: "status-line", text: `Script: ${entry.script}` }),
      bypassResultBlock(cb.lastBypassResults[key]),
    ]);
  });

  const pickBtn = el("button", { class: "btn", text: "Choose .mogrt…", onClick: () => pickMogrt().then(onChange) });
  const runBtn = el("button", {
    class: "btn btn-primary",
    text: cb.running ? "Testing…" : "Test CEP Write (POC)",
    disabled: !isHosted() || cb.running || cb.probeRunning || cb.rawBytesRunning || !cb.mogrtPath || undefined,
    onClick: async () => {
      await runWriteProof();
      onChange();
    },
  });
  const probeBtn = el("button", {
    class: "btn btn-primary",
    text: cb.probeRunning ? "Probing…" : "Probe Source Text (deep, read-first)",
    disabled: !isHosted() || cb.running || cb.probeRunning || cb.rawBytesRunning || !cb.mogrtPath || undefined,
    onClick: async () => {
      await runSourceTextProbe();
      onChange();
    },
  });
  const rawBytesBtn = el("button", {
    class: "btn btn-primary",
    text: cb.rawBytesRunning ? "Inspecting…" : "Inspect Source Text Raw Bytes",
    disabled: !isHosted() || cb.running || cb.probeRunning || cb.rawBytesRunning || !cb.mogrtPath || undefined,
    onClick: async () => {
      await runRawBytesInspection();
      onChange();
    },
  });
  const skipFileSaveCheckbox = el("input", { type: "checkbox" });
  skipFileSaveCheckbox.checked = cb.skipFileSave;
  skipFileSaveCheckbox.addEventListener("change", () => {
    patchCepBridge({ skipFileSave: skipFileSaveCheckbox.checked });
    onChange();
  });
  const skipFileSaveLabel = el("label", { class: "field-inline" }, [
    skipFileSaveCheckbox,
    " Skip temp-file writing (isolates whether file I/O is the crash cause)",
  ]);
  const selfTestBtn = el("button", {
    class: "btn",
    text: cb.selfTestRunning ? "Testing…" : "Run Byte/JSON Helper Self-Test (no Premiere objects touched)",
    disabled: !isHosted() || cb.selfTestRunning || undefined,
    onClick: async () => {
      await runRawBytesHelperSelfTest();
      onChange();
    },
  });

  const bisectStepInput = el("input", { type: "number", min: "0", max: String(BISECT_MAX_STEP), step: "1" });
  bisectStepInput.value = String(cb.bisectStep);
  bisectStepInput.addEventListener("change", () => {
    const n = Math.max(0, Math.min(BISECT_MAX_STEP, Number(bisectStepInput.value) || 0));
    patchCepBridge({ bisectStep: n });
    onChange();
  });
  const bisectStepLabel = el("label", { class: "field-inline" }, [" Bisect step (0–" + BISECT_MAX_STEP + "): ", bisectStepInput]);
  const bisectRunBtn = el("button", {
    class: "btn",
    text: cb.bisectRunning ? "Running…" : `Run Bisect Step ${cb.bisectStep}`,
    disabled: !isHosted() || cb.bisectRunning || undefined,
    onClick: async () => {
      await runBisectStep();
      onChange();
    },
  });
  const bisectNextBtn = el("button", {
    class: "btn",
    text: "Run Bisect Step, Then Advance ↦",
    disabled: !isHosted() || cb.bisectRunning || cb.bisectStep >= BISECT_MAX_STEP || undefined,
    onClick: async () => {
      await runBisectStep();
      if (store.getState().cepBridge.lastBisectResult?.ok) {
        patchCepBridge({ bisectStep: Math.min(BISECT_MAX_STEP, cb.bisectStep + 1) });
      }
      onChange();
    },
  });

  return el("section", { class: "panel panel-cep-bridge" }, [
    el("h2", { text: "7. CEP Bridge (experimental)" }),
    hostCompatibilityStatusBlock(cb, onChange),
    el(
      "p",
      { class: "hint" },
      [
        "Everything below is retained for reference only — CEP ExtendScript execution is confirmed unavailable on " +
          "this host (see the status banner above and docs/CEP_BRIDGE_INVESTIGATION.md Part 17). None of these " +
          "diagnostics can succeed until that changes; they are not being actively re-run.",
      ]
    ),
    el(
      "p",
      { class: "hint" },
      [
        "Step 0 first: check what's actually loaded in the live ExtendScript engine before running anything else. " +
          'A real-host bisection found that even a bare-minimum command ("bisectHostScript" step 0, no code beyond a ' +
          "single return statement) fails with the same non-JSON \"EvalScript error.\" as every command added since " +
          '"probeSourceTextDeep" (still working) — pointing at Premiere\'s ExtendScript engine only loading the ' +
          "manifest's ScriptPath file ONCE per running Premiere Pro process, not on every CEP panel reopen. See " +
          "docs/CEP_BRIDGE_INVESTIGATION.md Part 12.",
      ]
    ),
    el("div", { class: "row" }, [buildCheckBtn]),
    buildCheckResultBlock(cb.lastBuildCheckResult),
    el("div", { class: "row" }, [el("label", { class: "field-inline" }, ["Echo test value: ", echoInput]), echoBtn]),
    echoResultBlock(cb.lastEchoResult),
    el(
      "p",
      { class: "hint" },
      [
        'A full Premiere restart did NOT fix it — the engine-caching hypothesis is disproven. These eight tests ' +
          "bypass hostscript.jsx's dispatch() entirely, running literal ExtendScript source directly via " +
          "evalScript(), to isolate exactly which invocation layer breaks: a pure literal, a bare-global " +
          "already-working helper, a bare-global brand-new function, a deliberately-wrong bare reference to " +
          '"dispatch" (expected to fail), two hand-escaped calls to the correctly-scoped dispatch() — one for a ' +
          "known-working command, one for a known-failing one — plus typeof $._captionStudioBridge and a built-in " +
          "ExtendScript global (app.name), to check whether the namespace loaded and whether evalScript() works " +
          "at all. See docs/CEP_BRIDGE_INVESTIGATION.md Parts 13 and 16.",
      ]
    ),
    ...bypassRows,
    el(
      "p",
      { class: "hint" },
      [
        "Proof of concept ONLY — not part of the normal workflow. Nine rounds of UXP investigation " +
          "(docs/MOGRT_DIAGNOSTIC.md) found that UXP's createSetValueAction() cannot write native Premiere MOGRT " +
          "Source Text. This tests whether ExtendScript's ComponentParam.setValue() can, through a small local CEP " +
          `bridge (see docs/CEP_BRIDGE_INVESTIGATION.md and cep-bridge/README.md). Requires the "Caption Studio ` +
          "CEP Bridge\" CEP panel to be open in Premiere first (Window > Extensions) — otherwise this reports " +
          "\"CEP bridge unavailable\". Windows only for now (Premiere disallows plain http:// on macOS; see the " +
          "investigation doc's limitations section). Inserts the chosen .mogrt at the playhead, sets its duration " +
          `to 2s, and attempts to write "${CEP_WRITE_PROOF_SENTINEL}" to its Source Text param — the created clip ` +
          "is left on the timeline (not auto-removed) so you can inspect it directly.",
      ]
    ),
    el("div", { class: "row" }, [pickBtn]),
    el("div", { class: "status-line", text: cb.mogrtPath || "No .mogrt chosen yet." }),
    el("div", { class: "row" }, [runBtn]),
    resultBlock(cb.lastResult),
    el(
      "p",
      { class: "hint" },
      [
        "Read-before-write investigation: inserts the chosen .mogrt, then dumps everything reflect-visible about " +
          "the Source Text ComponentParam and getValue()'s return value BEFORE calling setValue() — only attempting " +
          "a targeted write (and reporting a full before/after diff) if that dump reveals a genuinely constructible " +
          `(plain-object or JSON-string) shape with an identifiable text-like field. See ` +
          "docs/CEP_BRIDGE_INVESTIGATION.md Part 8.",
      ]
    ),
    el("div", { class: "row" }, [probeBtn]),
    probeResultBlock(cb.lastProbeResult),
    el(
      "p",
      { class: "hint" },
      [
        "Byte-level inspection: built after a probe run reported typeof \"string\" for getValue() with a preview that " +
          'looked like "{}", yet JSON.parse() failed. Logs the exact string length, JSON.stringify() of the whole ' +
          "string, every character code + hex, the first/last 32 characters, and five JSON.parse() attempts (raw, " +
          "trimmed, BOM-stripped, null-stripped, fully-normalized) with exact failure messages/positions. Never " +
          "calls setValue(). Also saves the full result to a JSON file in the OS temp folder. See " +
          "docs/CEP_BRIDGE_INVESTIGATION.md Part 9.",
      ]
    ),
    el("div", { class: "row" }, [rawBytesBtn]),
    el("div", { class: "row" }, [skipFileSaveLabel]),
    rawBytesResultBlock(cb.lastRawBytesResult),
    el(
      "p",
      { class: "hint" },
      [
        'Self-test: runs the exact same character-code-dump/JSON.parse helpers against a built-in dummy string ' +
          "(with a BOM, a null character, and surrounding whitespace around \"{}\") — zero Premiere host objects " +
          "touched (no project/sequence/MOGRT). If \"Inspect Source Text Raw Bytes\" fails with a non-JSON " +
          '"EvalScript error." but THIS succeeds, the fault is in the MOGRT-insertion/file-I/O path, not the ' +
          "byte/JSON logic itself. See docs/CEP_BRIDGE_INVESTIGATION.md Part 10.",
      ]
    ),
    el("div", { class: "row" }, [selfTestBtn]),
    selfTestResultBlock(cb.lastSelfTestResult),
    el(
      "p",
      { class: "hint" },
      [
        "Bisection: since the self-test above still fails with a non-JSON \"EvalScript error.\" while touching zero " +
          "Premiere APIs, the fault is somewhere in this file's own code. Steps 0–11 add exactly one construct at a " +
          "time (return a plain object → a string literal → .length → JSON.stringify() → a charCodeAt loop → hex " +
          "conversion → the real charCodeHexDump() → a bare JSON.parse() → the real tryJsonParse() → the real " +
          "stripNullChars() → the real testRawBytesHelpers()). Run step 0, confirm it succeeds, then advance one " +
          "step at a time — the first step that returns \"EvalScript error.\" instead of a JSON result is the exact " +
          "breaking statement. See docs/CEP_BRIDGE_INVESTIGATION.md Part 11.",
      ]
    ),
    el("div", { class: "row" }, [bisectStepLabel]),
    el("div", { class: "row" }, [bisectRunBtn, bisectNextBtn]),
    bisectResultBlock(cb.lastBisectResult),
  ]);
}
