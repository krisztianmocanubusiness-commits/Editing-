import { el, field, numberInput, colorInput } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { runSmokeTest } from "../ppro/smokeTest.js";
import { KERIS_CAPTION_V1_PPRO } from "../presets/contracts/index.js";
import { describeCompliance, describeCompatibilityLabel } from "../presets/contractValidation.js";

function patchSmokeTest(patch) {
  store.set((s) => ({ smokeTest: { ...s.smokeTest, ...patch } }));
}

async function pickTestMogrt() {
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ["mogrt"] });
    if (!file) return;
    patchSmokeTest({ mogrtPath: file.nativePath });
    log(`Test MOGRT set: ${file.nativePath}`, "info");
  } catch (err) {
    log(`Couldn't pick a .mogrt file: ${err.message || err}`, "error");
  }
}

async function run() {
  const st = store.getState().smokeTest;
  if (!st.mogrtPath) {
    log("Pick a test .mogrt before running the smoke test.", "error");
    return;
  }
  patchSmokeTest({ running: true, lastResult: null, lastCompliance: null });
  try {
    const result = await runSmokeTest({
      mogrtPath: st.mogrtPath,
      text: st.text,
      fontSize: st.fontSize,
      fillColorHex: st.fillColor,
      positionX: st.positionX,
      positionY: st.positionY,
      log,
    });
    if (!result.ok) {
      patchSmokeTest({ lastResult: "fail" });
      return;
    }
    patchSmokeTest({
      lastResult: result.allCorePassed ? "pass" : "partial",
      lastCompliance: result.compliance,
      lastCoreFields: result.coreFields,
    });
  } catch (err) {
    log(`Smoke test crashed unexpectedly: ${err.message || err}`, "error");
    patchSmokeTest({ lastResult: "fail" });
  } finally {
    patchSmokeTest({ running: false });
  }
}

function resultBadge(lastResult, coreFields) {
  if (!lastResult) return el("span", { class: "status-line", text: "Not run yet." });
  const fieldList = coreFields?.length ? coreFields.join(", ") : "core";
  const map = {
    pass: { text: `PASS — all ${coreFields?.length ?? ""} core params (${fieldList}) set successfully.`, cls: "log-success" },
    partial: { text: "PARTIAL — some params set, others failed. See log for exactly which.", cls: "log-warn" },
    fail: { text: "FAIL — see log for the step that failed.", cls: "log-error" },
  };
  const info = map[lastResult];
  return el("span", { class: `status-line ${info.cls}`, text: info.text });
}

function complianceBadge(compliance) {
  if (!compliance) return null;
  const cls = compliance.isCompliant ? "log-success" : "log-error";
  const contract = compliance.contractId === KERIS_CAPTION_V1_PPRO.id ? KERIS_CAPTION_V1_PPRO : null;
  const compatibilitySuffix = contract ? ` (${describeCompatibilityLabel(contract)})` : "";
  return el("div", { class: `status-line ${cls}`, text: `${describeCompliance(compliance)}${compatibilitySuffix}` });
}

export function renderSmokeTestPanel(onChange) {
  const state = store.getState();
  const st = state.smokeTest;

  const runBtn = el("button", {
    class: "btn btn-primary",
    text: st.running ? "Running…" : "Run Smoke Test",
    disabled: !isHosted() || st.running || undefined,
    onClick: async () => {
      await run();
      onChange();
    },
  });

  const pickBtn = el("button", {
    class: "btn",
    text: "Choose test .mogrt…",
    onClick: () => pickTestMogrt().then(onChange),
  });

  const textInput = el("input", { type: "text", value: st.text });
  textInput.addEventListener("input", () => patchSmokeTest({ text: textInput.value }));

  return el("section", { class: "panel panel-smoke-test" }, [
    el("h2", { text: "0. Host smoke test — run this first" }),
    el(
      "p",
      { class: "hint" },
      [
        `Validates the real Premiere connection end to end against ${KERIS_CAPTION_V1_PPRO.id} ` +
          `(${describeCompatibilityLabel(KERIS_CAPTION_V1_PPRO)}, the recommended default for Premiere-authored ` +
          "MOGRTs): inserts one MOGRT, sets text / font size / fill colour / position / tracking / background / " +
          "shadow on it, and logs every step (success or failure) below and in the UDT console. Building an " +
          "After-Effects-authored template instead? Pass the fuller KERIS_CAPTION_V1 contract in code — see " +
          `docs/PREMIERE_HOST_TEST.md and ${KERIS_CAPTION_V1_PPRO.docPath} for manual steps and the full ` +
          "required-param spec.",
      ]
    ),
    el("div", { class: "row" }, [pickBtn]),
    el("div", { class: "status-line", text: st.mogrtPath || "No test .mogrt chosen yet." }),
    el("div", { class: "options-grid" }, [
      field("Test text", textInput),
      field("Font size", numberInput(st.fontSize, (v) => patchSmokeTest({ fontSize: v }), { min: 8, max: 400 })),
      field("Fill colour", colorInput(st.fillColor, (v) => patchSmokeTest({ fillColor: v }))),
      field("Position X", numberInput(st.positionX, (v) => patchSmokeTest({ positionX: v }), { min: -4000, max: 4000 })),
      field("Position Y", numberInput(st.positionY, (v) => patchSmokeTest({ positionY: v }), { min: -4000, max: 4000 })),
    ]),
    el("div", { class: "row" }, [runBtn]),
    resultBadge(st.lastResult, st.lastCoreFields),
    complianceBadge(st.lastCompliance),
  ]);
}
