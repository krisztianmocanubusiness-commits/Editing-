import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { inspectMogrt } from "../ppro/templateInspector.js";
import { diagnoseMogrt, cancelActiveDiagnostic } from "../ppro/diagnostics.js";
import { saveActiveTemplate } from "../state/settings.js";
import { KERIS_CAPTION_V1_PPRO, getContract } from "../presets/contracts/index.js";
import { describeCompatibilityLabel } from "../presets/contractValidation.js";

function patchInspector(patch) {
  store.set((s) => ({ templateInspector: { ...s.templateInspector, ...patch } }));
}

async function pickMogrt() {
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["mogrt"] });
    if (!file) return;
    patchInspector({ mogrtPath: file.nativePath, lastResult: null });
    log(`Template chosen for inspection: ${file.nativePath}`, "info");
  } catch (err) {
    log(`Couldn't pick a .mogrt file: ${err.message || err}`, "error");
  }
}

async function inspect() {
  const { mogrtPath } = store.getState().templateInspector;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchInspector({ running: true, lastResult: null });
  try {
    const result = await inspectMogrt({ mogrtPath, log });
    patchInspector({ lastResult: result });
  } catch (err) {
    log(`Template Inspector crashed unexpectedly: ${err.message || err}`, "error");
    patchInspector({ lastResult: { ok: false, step: "crash" } });
  } finally {
    patchInspector({ running: false });
  }
}

function saveAsActive() {
  const { lastResult } = store.getState().templateInspector;
  if (!lastResult || !lastResult.ok) {
    log("Inspect a template successfully before saving it as active.", "error");
    return;
  }
  const contractId = lastResult.compliance.isCompliant ? lastResult.compliance.contractId : lastResult.detection.detectedContractId;
  const saveResult = saveActiveTemplate({
    path: lastResult.mogrtPath,
    contractId,
    compliant: lastResult.compliance.isCompliant,
  });
  store.set({ activeTemplate: saveResult.value });

  if (!lastResult.compliance.isCompliant) {
    const contract = getContract(lastResult.targetContractId);
    log(
      `⚠ Saved a NON-COMPLIANT template as active (missing: ${lastResult.compliance.missingRequired.join(", ")}). ` +
        `Timeline apply will still try, but some style fields won't land — see ${contract?.docPath ?? "mogrt-authoring/PREMIERE_ONLY_GUIDE.md"}.`,
      "warn"
    );
  } else {
    log(`✓ Saved as active template: ${lastResult.mogrtPath} (${lastResult.targetCompatibility})`, "success");
  }
  if (!saveResult.persisted) {
    log("Note: this session's storage doesn't support persisting settings across restarts — the active template will need to be re-saved next time you open the panel. See docs/TEMPLATE_INSPECTOR.md.", "warn");
  }
}

function complianceSummaryBlock(result) {
  if (!result || !result.ok) return null;
  const { compliance, extraParams, detection } = result;

  return el("div", { class: "inspector-results" }, [
    el("div", {
      class: `status-line ${compliance.isCompliant ? "log-success" : "log-error"}`,
      text: `${compliance.isCompliant ? "COMPLIANT" : "NOT COMPLIANT"} with ${result.targetContractId} (${result.targetCompatibility})`,
    }),
    el("div", { class: "status-line", text: `Missing required: ${compliance.missingRequired.length ? compliance.missingRequired.join(", ") : "none"}` }),
    el("div", { class: "status-line", text: `Extra params: ${extraParams.length ? extraParams.join(", ") : "none"}` }),
    el("div", {
      class: "status-line",
      text: detection.detectedContractId
        ? `Detected contract: ${detection.detectedContractId} (${result.detectedCompatibility})`
        : `Detected contract: none matched exactly${detection.bestGuessContractId ? ` (closest: ${detection.bestGuessContractId})` : ""}`,
    }),
  ]);
}

async function runDiagnostic() {
  const { mogrtPath } = store.getState().templateInspector;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchInspector({ diagnosing: true, lastDiagnostic: null });
  try {
    const result = await diagnoseMogrt({ mogrtPath, log });
    patchInspector({ lastDiagnostic: result });
  } catch (err) {
    log(`Diagnostic Inspector crashed unexpectedly: ${err.message || err}`, "error");
    patchInspector({ lastDiagnostic: { ok: false, step: "crash" } });
  } finally {
    patchInspector({ diagnosing: false });
  }
}

function cancelDiagnostic() {
  const cancelled = cancelActiveDiagnostic();
  log(
    cancelled
      ? "Cancel requested — the scan will stop at its next checkpoint (may take up to a second) and still clean up the temporary clip."
      : "Nothing to cancel — no diagnostic scan is currently running.",
    cancelled ? "warn" : "info"
  );
}

async function saveDiagnosticJson() {
  const { lastDiagnostic } = store.getState().templateInspector;
  if (!lastDiagnostic || !lastDiagnostic.ok) {
    log("Run the Diagnostic Inspector successfully before saving its output.", "error");
    return;
  }
  try {
    const uxp = getUxp();
    // Save the classification report WITHOUT the (much larger) raw probe —
    // that gets its own file via saveRawProbeJson() below, per
    // docs/MOGRT_DIAGNOSTIC.md's "two files, two purposes" split.
    const { rawProbe, ...withoutRawProbe } = lastDiagnostic;
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving("mogrt-diagnostic.json", { types: ["json"] });
    if (!file) return;
    await file.write(JSON.stringify(withoutRawProbe, null, 2));
    log(`Diagnostic saved to ${file.nativePath}.`, "success");
  } catch (err) {
    log(`Saving diagnostic JSON failed: ${err.message || err}`, "error");
  }
}

async function saveRawProbeJson() {
  const { lastDiagnostic } = store.getState().templateInspector;
  if (!lastDiagnostic || !lastDiagnostic.ok || !lastDiagnostic.rawProbe) {
    log("Run the Diagnostic Inspector successfully before saving the raw probe.", "error");
    return;
  }
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving("mogrt-raw-probe.json", { types: ["json"] });
    if (!file) return;
    // Includes textComponentProbe (the dedicated AE.ADBE Text extraction
    // pass) alongside the generic rawProbe, so both live in one file.
    await file.write(JSON.stringify({ ...lastDiagnostic.rawProbe, textComponentProbe: lastDiagnostic.textComponentProbe }, null, 2));
    log(`Raw probe saved to ${file.nativePath}.`, "success");
  } catch (err) {
    log(`Saving raw probe JSON failed: ${err.message || err}`, "error");
  }
}

function diagnosticSummaryBlock(result, diagnosing) {
  if (diagnosing) {
    return el("div", { class: "inspector-results" }, [
      el("div", {
        class: "status-line log-info",
        text: "⏳ Running diagnostic scan — inserting a temporary clip, then waiting (up to ~6s) for Premiere to finish materializing the MOGRT's " +
          "components before running the deeper raw probe (a fresh, separate ~12s budget) — bounded to finish either way, even if something hangs; " +
          "see Log below for live per-component/per-param progress, or click Cancel to stop early.",
      }),
    ]);
  }
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", {
        class: "status-line log-error",
        text: `✗ Diagnostic Inspector failed${stepLabel}${result.error ? `: ${result.error}` : ""}. The temporary clip is removed either way — see Log below.`,
      }),
    ]);
  }
  const byClass = result.components.reduce((acc, c) => {
    acc[c.classification] = (acc[c.classification] || 0) + 1;
    return acc;
  }, {});
  const textEditingCount = byClass["text-editing"] ?? 0;
  const graphicCount = byClass["graphic-or-mogrt"] ?? 0;
  const foundCustomControls = textEditingCount + graphicCount > 0;

  // Every component so far classifying as "intrinsic" (or unrecognized)
  // means nothing that looks like a genuine custom MOGRT control was
  // found — say so plainly instead of "N graphic-or-mogrt components
  // found", which read as a success even when it wasn't one. A
  // "text-editing" component (AE.ADBE Text, confirmed via a real host run)
  // always counts as found. See docs/MOGRT_DIAGNOSTIC.md.
  const headline = foundCustomControls
    ? `${result.components.length} component(s) found: ${byClass.intrinsic ?? 0} intrinsic, ${textEditingCount} text-editing, ` +
      `${graphicCount} graphic-or-mogrt (possible custom control${graphicCount === 1 ? "" : "s"}), ` +
      `${byClass["effect-or-unknown"] ?? 0} effect-or-unknown.`
    : `MOGRT inserted, but no custom editable controls were discovered — ${result.components.length} component(s) found, ` +
      `all intrinsic/standard (${byClass.intrinsic ?? 0} intrinsic, ${byClass["effect-or-unknown"] ?? 0} unrecognized). ` +
      "See the raw probe (below) for what's actually inside each one.";

  const textProbe = result.textComponentProbe;
  const timeline = result.componentDiscoveryTimeline ?? [];
  const textProbeLine = textProbe
    ? el("div", {
        class: `status-line ${textProbe.partial ? "log-warn" : "log-success"}`,
        text: `${textProbe.partial ? "⚠" : "✓"} AE.ADBE Text component found at index ${textProbe.componentIndex} — ` +
          `${textProbe.params.length}${textProbe.paramCount ? `/${textProbe.paramCount}` : ""} parameter(s) probed in depth` +
          `${textProbe.partial ? " — STOPPED EARLY, only partially inspected (see raw probe JSON for what was captured, re-run to continue)" : ""}.`,
      })
    : el("div", {
        class: "status-line log-warn",
        // Never state categorically that the template has no Text
        // component — a previous scan already proved this one does; the
        // stabilization wait (see the discovery timeline below) may simply
        // not have been long enough this run. See docs/MOGRT_DIAGNOSTIC.md.
        text: `MOGRT component chain did not fully initialise before timeout. AE.ADBE Text was not found within the wait window` +
          `${timeline.length ? ` (${timeline.length} discovery attempt${timeline.length === 1 ? "" : "s"}, see the Log/saved JSON for the full timeline)` : ""}` +
          " — this does not mean the template lacks one. Try again, or check the Log for exactly which components stabilized.",
      });

  const timelineLine = timeline.length
    ? el("div", {
        class: "status-line",
        text: `Component discovery timeline: ${timeline.map((t) => `attempt ${t.attempt} @${t.elapsedMs}ms → ${t.componentCount} found`).join("; ")}.`,
      })
    : null;

  return el("div", { class: "inspector-results" }, [
    result.partial
      ? el("div", {
          class: "status-line log-warn",
          text: "⚠ PARTIAL RESULTS — the scan stopped early (time budget exceeded or cancelled) before finishing every component/param. " +
            "What's below/in the saved JSON is everything collected up to that point, not the whole picture. Re-run with a longer budget if you need more.",
        })
      : null,
    textProbeLine,
    timelineLine,
    el("div", {
      class: `status-line ${foundCustomControls ? "log-success" : "log-warn"}`,
      text: headline,
    }),
    ...result.components.map((c) =>
      el("div", {
        class: "status-line",
        text: `  [${c.classification}] "${c.displayName ?? "n/a"}" — ${c.paramCount} param(s)`,
      })
    ),
    el("div", { class: "status-line", text: "Component/param detail is in the Log below and the saved diagnostic JSON. For the deeper raw host-object probe (shape/methods of every component, param, and resolved value) plus the dedicated AE.ADBE Text extraction pass (display names, resolved value/position for every param), see the saved raw probe JSON." }),
  ]);
}

function activeTemplateLine(activeTemplate) {
  if (!activeTemplate) {
    return el("div", { class: "status-line log-warn", text: "No active template saved yet." });
  }
  const contract = getContract(activeTemplate.contractId);
  const compatibilitySuffix = contract ? ` — ${describeCompatibilityLabel(contract)}` : "";
  return el("div", {
    class: `status-line ${activeTemplate.compliant ? "log-success" : "log-warn"}`,
    text: `Active template: ${activeTemplate.path} (contract: ${activeTemplate.contractId ?? "unknown"}${compatibilitySuffix}${activeTemplate.compliant ? "" : ", NOT compliant"})`,
  });
}

export function renderTemplateInspectorPanel(onChange) {
  const state = store.getState();
  const ti = state.templateInspector;

  const pickBtn = el("button", { class: "btn", text: "Choose .mogrt to inspect…", onClick: () => pickMogrt().then(onChange) });
  const inspectBtn = el("button", {
    class: "btn btn-primary",
    text: ti.running ? "Inspecting…" : "Inspect Template",
    disabled: !isHosted() || ti.running || !ti.mogrtPath || undefined,
    onClick: async () => {
      await inspect();
      onChange();
    },
  });
  const saveBtn = el("button", {
    class: "btn",
    text: "Save as active template",
    disabled: !ti.lastResult || !ti.lastResult.ok || undefined,
    onClick: () => {
      saveAsActive();
      onChange();
    },
  });

  const diagnosticBtn = el("button", {
    class: "btn",
    text: ti.diagnosing ? "Diagnosing…" : "Run Diagnostic Inspector",
    disabled: !isHosted() || ti.diagnosing || !ti.mogrtPath || undefined,
    onClick: async () => {
      await runDiagnostic();
      onChange();
    },
  });
  const cancelDiagnosticBtn = el("button", {
    class: "btn",
    text: "Cancel",
    disabled: !ti.diagnosing || undefined,
    onClick: () => cancelDiagnostic(),
  });
  const saveDiagnosticBtn = el("button", {
    class: "btn",
    text: "Save diagnostic JSON…",
    disabled: !ti.lastDiagnostic || !ti.lastDiagnostic.ok || undefined,
    onClick: () => saveDiagnosticJson(),
  });
  const saveRawProbeBtn = el("button", {
    class: "btn",
    text: "Save raw probe JSON…",
    disabled: !ti.lastDiagnostic || !ti.lastDiagnostic.ok || !ti.lastDiagnostic.rawProbe || undefined,
    onClick: () => saveRawProbeJson(),
  });

  return el("section", { class: "panel panel-template-inspector" }, [
    el("h2", { text: `1. Template Inspector — set your active ${KERIS_CAPTION_V1_PPRO.id} template` }),
    el(
      "p",
      { class: "hint" },
      [
        `Select a .mogrt, inspect it against the real Premiere host, and see exactly which required params are ` +
          `present, missing, or extra — checked by default against ${KERIS_CAPTION_V1_PPRO.id} ` +
          `(${describeCompatibilityLabel(KERIS_CAPTION_V1_PPRO)}, the recommended contract for templates built in ` +
          "Premiere alone). If your template also satisfies the fuller After Effects contract " +
          "(KERIS_CAPTION_V1 — split Position X/Y, a baked Entrance Style rig), the \"Detected contract\" line " +
          "below says so. Save a template as \"active\" here once, and the timeline apply step below uses it by " +
          "default. See docs/TEMPLATE_INSPECTOR.md and mogrt-authoring/PREMIERE_ONLY_GUIDE.md.",
      ]
    ),
    el("div", { class: "row" }, [pickBtn]),
    el("div", { class: "status-line", text: ti.mogrtPath || "No .mogrt chosen yet." }),
    el("div", { class: "row" }, [inspectBtn]),
    complianceSummaryBlock(ti.lastResult),
    el("div", { class: "row" }, [saveBtn]),
    activeTemplateLine(state.activeTemplate),
    el("h3", { text: "Diagnostic Inspector (troubleshooting)" }),
    el(
      "p",
      { class: "hint" },
      [
        "Dumps the full component/param graph found on this .mogrt with no assumptions about which " +
          "params are meaningful — every component's display name and best-effort match name, classified " +
          "as intrinsic (Motion/Opacity/Crop/Time Remapping, including their AE.ADBE-prefixed forms and the " +
          "Graphic Group wrapper — all present on every graphic clip, custom or not), text-editing (an exact " +
          "AE.ADBE Text match — confirmed via a real host run to be the genuine editable text component, and " +
          "probed with priority, before the intrinsic ones), graphic-or-mogrt (a weaker signal like a " +
          "text-related name), or effect-or-unknown. Also runs a deeper raw probe — the real shape " +
          "(Object.keys, prototype methods, constructor, safely-called zero-arg getters — never a method that " +
          "needs an argument, like getValueAtTime or getParam, even if the host misreports it as zero-arg) of " +
          "the track item, its project item, and every component/param/resolved value, plus a dedicated " +
          "AE.ADBE Text extraction pass (every param's display name and resolved getStartValue().value/" +
          "position) — saved as its own JSON. Every host value read is timeout-guarded and the whole scan has " +
          "a shared time budget (~12s), so it always finishes — with partial results, clearly marked, if it " +
          "ran out of time — instead of hanging. See docs/MOGRT_DIAGNOSTIC.md.",
      ]
    ),
    el("div", { class: "row" }, [diagnosticBtn, cancelDiagnosticBtn, saveDiagnosticBtn, saveRawProbeBtn]),
    diagnosticSummaryBlock(ti.lastDiagnostic, ti.diagnosing),
  ]);
}
