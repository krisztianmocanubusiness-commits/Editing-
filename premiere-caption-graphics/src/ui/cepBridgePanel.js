import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { testCepWriteProof, CEP_WRITE_PROOF_SENTINEL } from "../ppro/cepBridge.js";

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

function resultBlock(result) {
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ CEP Bridge Write Proof failed${stepLabel}${result.error ? `: ${result.error}` : ""}` }),
    ]);
  }
  const r = result.result ?? {};
  const lines = [
    el("div", { class: "status-line log-success", text: `✓ Clip created: "${r.trackItemName ?? "n/a"}" at ${typeof r.start === "number" ? r.start.toFixed(3) : "n/a"}s.` }),
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
  return el("div", { class: "inspector-results" }, lines);
}

export function renderCepBridgePanel(onChange) {
  const state = store.getState();
  const cb = state.cepBridge;

  const pickBtn = el("button", { class: "btn", text: "Choose .mogrt…", onClick: () => pickMogrt().then(onChange) });
  const runBtn = el("button", {
    class: "btn btn-primary",
    text: cb.running ? "Testing…" : "Test CEP Write (POC)",
    disabled: !isHosted() || cb.running || !cb.mogrtPath || undefined,
    onClick: async () => {
      await runWriteProof();
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
  ]);
}
