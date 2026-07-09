import { el, field, numberInput, colorInput } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { runSmokeTest } from "../ppro/smokeTest.js";
import { KERIS_CAPTION_V1 } from "../presets/contracts/index.js";
import { describeCompliance } from "../presets/contractValidation.js";

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
    const checks = [
      result.results.text.ok,
      result.results.fontSize.ok,
      result.results.fillColor.ok,
      result.results.position.ok,
      result.results.tracking.ok,
      result.results.entranceStyle.ok,
    ];
    const allCore = checks.every(Boolean);
    patchSmokeTest({ lastResult: allCore ? "pass" : "partial", lastCompliance: result.compliance });
  } catch (err) {
    log(`Smoke test crashed unexpectedly: ${err.message || err}`, "error");
    patchSmokeTest({ lastResult: "fail" });
  } finally {
    patchSmokeTest({ running: false });
  }
}

function resultBadge(lastResult) {
  if (!lastResult) return el("span", { class: "status-line", text: "Not run yet." });
  const map = {
    pass: { text: "PASS — all 6 core params (text, size, colour, position, tracking, entrance style) set successfully.", cls: "log-success" },
    partial: { text: "PARTIAL — some params set, others failed. See log for exactly which.", cls: "log-warn" },
    fail: { text: "FAIL — see log for the step that failed.", cls: "log-error" },
  };
  const info = map[lastResult];
  return el("span", { class: `status-line ${info.cls}`, text: info.text });
}

function complianceBadge(compliance) {
  if (!compliance) return null;
  const cls = compliance.isCompliant ? "log-success" : "log-error";
  return el("div", { class: `status-line ${cls}`, text: describeCompliance(compliance) });
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
        `Validates the real Premiere connection end to end against the ${KERIS_CAPTION_V1.id} contract: inserts one ` +
          "MOGRT, sets text / font size / fill colour / position / tracking / entrance style on it, and logs every " +
          "step (success or failure) below and in the UDT console. See docs/PREMIERE_HOST_TEST.md and " +
          `${KERIS_CAPTION_V1.docPath} for manual steps and the full required-param spec.`,
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
    resultBadge(st.lastResult),
    complianceBadge(st.lastCompliance),
  ]);
}
