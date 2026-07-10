import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { inspectMogrt } from "../ppro/templateInspector.js";
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
  ]);
}
