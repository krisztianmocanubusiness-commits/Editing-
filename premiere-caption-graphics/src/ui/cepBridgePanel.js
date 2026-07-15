import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { testCepWriteProof, probeSourceTextDeep, CEP_WRITE_PROOF_SENTINEL, CEP_SOURCE_TEXT_PROBE_SENTINEL } from "../ppro/cepBridge.js";

function patchCepBridge(patch) {
  store.set((s) => ({ cepBridge: { ...s.cepBridge, ...patch } }));
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

export function renderCepBridgePanel(onChange) {
  const state = store.getState();
  const cb = state.cepBridge;

  const pickBtn = el("button", { class: "btn", text: "Choose .mogrt…", onClick: () => pickMogrt().then(onChange) });
  const runBtn = el("button", {
    class: "btn btn-primary",
    text: cb.running ? "Testing…" : "Test CEP Write (POC)",
    disabled: !isHosted() || cb.running || cb.probeRunning || !cb.mogrtPath || undefined,
    onClick: async () => {
      await runWriteProof();
      onChange();
    },
  });
  const probeBtn = el("button", {
    class: "btn btn-primary",
    text: cb.probeRunning ? "Probing…" : "Probe Source Text (deep, read-first)",
    disabled: !isHosted() || cb.running || cb.probeRunning || !cb.mogrtPath || undefined,
    onClick: async () => {
      await runSourceTextProbe();
      onChange();
    },
  });

  return el("section", { class: "panel panel-cep-bridge" }, [
    el("h2", { text: "7. CEP Bridge (experimental)" }),
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
  ]);
}
