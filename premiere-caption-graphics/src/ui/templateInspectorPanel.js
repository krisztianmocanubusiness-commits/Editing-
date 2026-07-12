import { el } from "./components/dom.js";
import { store } from "../state/store.js";
import { log } from "../util/log.js";
import { getUxp, isHosted } from "../ppro/client.js";
import { inspectMogrt } from "../ppro/templateInspector.js";
import { diagnoseMogrt, cancelActiveDiagnostic } from "../ppro/diagnostics.js";
import {
  testSourceTextRoundTrip,
  cancelActiveSourceTextRoundTrip,
  testReadSourceTextOnly,
  cancelActiveReadSourceTextOnly,
  testExploreKeyframeObject,
  cancelActiveExploreKeyframeObject,
  testWriteOnlyProbe,
  cancelActiveWriteOnlyProbe,
  WRITE_PROBE_SENTINEL,
  testProbeSourceTextValueShapes,
  cancelActiveValueShapesProbe,
} from "../ppro/sourceTextProbe.js";
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

async function runSourceTextRoundTripTest() {
  const { mogrtPath } = store.getState().templateInspector;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchInspector({ sourceTextRoundTripRunning: true, lastSourceTextRoundTrip: null });
  try {
    const result = await testSourceTextRoundTrip({ mogrtPath, log });
    // TEMPORARY: also dump the full result to console.error() (not just the
    // panel log/UI) so it's still retrievable via the UXP Developer Tool's
    // Console tab even if the panel's log UI breaks or scrolls it away.
    // Remove once the Source Text round trip is confirmed stable on a real host.
    console.error("[Caption Graphics Studio] Source Text Round Trip result:", JSON.stringify(result, null, 2));
    patchInspector({ lastSourceTextRoundTrip: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] Source Text Round Trip crashed:", err);
    log(`Source Text Round Trip crashed unexpectedly: ${err.message || err}`, "error");
    patchInspector({ lastSourceTextRoundTrip: { ok: false, step: "crash" } });
  } finally {
    patchInspector({ sourceTextRoundTripRunning: false });
  }
}

function cancelSourceTextRoundTrip() {
  const cancelled = cancelActiveSourceTextRoundTrip();
  log(
    cancelled
      ? "Cancel requested — the round trip will stop at its next checkpoint and still clean up the temporary clip."
      : "Nothing to cancel — no Source Text round trip is currently running.",
    cancelled ? "warn" : "info"
  );
}

async function runReadSourceTextOnlyTest() {
  const { mogrtPath } = store.getState().templateInspector;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchInspector({ readSourceTextOnlyRunning: true, lastReadSourceTextOnly: null });
  try {
    const result = await testReadSourceTextOnly({ mogrtPath, log });
    // TEMPORARY: also dump the full result to console.error() (not just the
    // panel log/UI), same reasoning as the round trip below — retrievable
    // via the UXP Developer Tool's Console tab even if the panel UI breaks.
    console.error("[Caption Graphics Studio] Read Source Text Only result:", JSON.stringify(result, null, 2));
    patchInspector({ lastReadSourceTextOnly: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] Read Source Text Only crashed:", err);
    log(`Read Source Text Only crashed unexpectedly: ${err.message || err}`, "error");
    patchInspector({ lastReadSourceTextOnly: { ok: false, step: "crash" } });
  } finally {
    patchInspector({ readSourceTextOnlyRunning: false });
  }
}

function cancelReadSourceTextOnly() {
  const cancelled = cancelActiveReadSourceTextOnly();
  log(
    cancelled
      ? "Cancel requested — the read will stop at its next checkpoint and still clean up the temporary clip."
      : "Nothing to cancel — no Read Source Text Only diagnostic is currently running.",
    cancelled ? "warn" : "info"
  );
}

async function saveReadSourceTextOnlyJson() {
  const { lastReadSourceTextOnly } = store.getState().templateInspector;
  if (!lastReadSourceTextOnly || !lastReadSourceTextOnly.ok || !lastReadSourceTextOnly.found) {
    log("Run Read Source Text Only successfully (with Source Text found) before saving its output.", "error");
    return;
  }
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving("mogrt-source-text-read.json", { types: ["json"] });
    if (!file) return;
    await file.write(JSON.stringify(lastReadSourceTextOnly, null, 2));
    log(`Source Text read diagnostic saved to ${file.nativePath}.`, "success");
  } catch (err) {
    log(`Saving Source Text read JSON failed: ${err.message || err}`, "error");
  }
}

async function runExploreKeyframeObjectTest() {
  const { mogrtPath } = store.getState().templateInspector;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchInspector({ exploreKeyframeObjectRunning: true, lastExploreKeyframeObject: null });
  try {
    const result = await testExploreKeyframeObject({ mogrtPath, log });
    // TEMPORARY: also dump the full result to console.error(), same
    // reasoning as the other Source Text diagnostics — retrievable via the
    // UXP Developer Tool's Console tab even if the panel UI breaks.
    console.error("[Caption Graphics Studio] Explore Keyframe Object result:", JSON.stringify(result, null, 2));
    patchInspector({ lastExploreKeyframeObject: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] Explore Keyframe Object crashed:", err);
    log(`Explore Keyframe Object crashed unexpectedly: ${err.message || err}`, "error");
    patchInspector({ lastExploreKeyframeObject: { ok: false, step: "crash" } });
  } finally {
    patchInspector({ exploreKeyframeObjectRunning: false });
  }
}

function cancelExploreKeyframeObject() {
  const cancelled = cancelActiveExploreKeyframeObject();
  log(
    cancelled
      ? "Cancel requested — the exploration will stop at its next checkpoint and still clean up the temporary clip."
      : "Nothing to cancel — no Explore Keyframe Object diagnostic is currently running.",
    cancelled ? "warn" : "info"
  );
}

async function saveExploreKeyframeObjectJson() {
  const { lastExploreKeyframeObject } = store.getState().templateInspector;
  if (!lastExploreKeyframeObject || !lastExploreKeyframeObject.ok || !lastExploreKeyframeObject.found) {
    log("Run Explore Keyframe Object successfully (with Source Text found) before saving its output.", "error");
    return;
  }
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving("mogrt-keyframe-explore.json", { types: ["json"] });
    if (!file) return;
    await file.write(JSON.stringify(lastExploreKeyframeObject, null, 2));
    log(`Keyframe exploration diagnostic saved to ${file.nativePath}.`, "success");
  } catch (err) {
    log(`Saving keyframe exploration JSON failed: ${err.message || err}`, "error");
  }
}

async function runWriteOnlyProbeTest() {
  const { mogrtPath } = store.getState().templateInspector;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchInspector({ writeOnlyProbeRunning: true, lastWriteOnlyProbe: null });
  try {
    const result = await testWriteOnlyProbe({ mogrtPath, log });
    // TEMPORARY: also dump the full result to console.error(), same
    // reasoning as the other Source Text diagnostics — retrievable via the
    // UXP Developer Tool's Console tab even if the panel UI breaks.
    console.error("[Caption Graphics Studio] Write-Only Probe result:", JSON.stringify(result, null, 2));
    patchInspector({ lastWriteOnlyProbe: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] Write-Only Probe crashed:", err);
    log(`Write-Only Probe crashed unexpectedly: ${err.message || err}`, "error");
    patchInspector({ lastWriteOnlyProbe: { ok: false, step: "crash" } });
  } finally {
    patchInspector({ writeOnlyProbeRunning: false });
  }
}

function cancelWriteOnlyProbe() {
  const cancelled = cancelActiveWriteOnlyProbe();
  log(
    cancelled
      ? "Cancel requested — the probe will stop at its next checkpoint and still clean up the temporary clip."
      : "Nothing to cancel — no Write-Only Probe is currently running.",
    cancelled ? "warn" : "info"
  );
}

async function saveWriteOnlyProbeJson() {
  const { lastWriteOnlyProbe } = store.getState().templateInspector;
  if (!lastWriteOnlyProbe || !lastWriteOnlyProbe.ok || !lastWriteOnlyProbe.found) {
    log("Run Write-Only Probe successfully (with Source Text found) before saving its output.", "error");
    return;
  }
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving("mogrt-write-only-probe.json", { types: ["json"] });
    if (!file) return;
    await file.write(JSON.stringify(lastWriteOnlyProbe, null, 2));
    log(`Write-only probe diagnostic saved to ${file.nativePath}.`, "success");
  } catch (err) {
    log(`Saving write-only probe JSON failed: ${err.message || err}`, "error");
  }
}

async function runValueShapesProbeTest() {
  const { mogrtPath } = store.getState().templateInspector;
  if (!mogrtPath) {
    log("Choose a .mogrt to inspect first.", "error");
    return;
  }
  patchInspector({ valueShapesProbeRunning: true, lastValueShapesProbe: null });
  try {
    const result = await testProbeSourceTextValueShapes({ mogrtPath, log });
    // TEMPORARY: also dump the full result to console.error(), same
    // reasoning as the other Source Text diagnostics — retrievable via the
    // UXP Developer Tool's Console tab even if the panel UI breaks.
    console.error("[Caption Graphics Studio] Probe Source Text Value Shapes result:", JSON.stringify(result, null, 2));
    patchInspector({ lastValueShapesProbe: result });
  } catch (err) {
    console.error("[Caption Graphics Studio] Probe Source Text Value Shapes crashed:", err);
    log(`Probe Source Text Value Shapes crashed unexpectedly: ${err.message || err}`, "error");
    patchInspector({ lastValueShapesProbe: { ok: false, step: "crash" } });
  } finally {
    patchInspector({ valueShapesProbeRunning: false });
  }
}

function cancelValueShapesProbe() {
  const cancelled = cancelActiveValueShapesProbe();
  log(
    cancelled
      ? "Cancel requested — the probe will stop at its next checkpoint and still clean up the temporary clip."
      : "Nothing to cancel — no value-shapes probe is currently running.",
    cancelled ? "warn" : "info"
  );
}

async function saveValueShapesProbeJson() {
  const { lastValueShapesProbe } = store.getState().templateInspector;
  if (!lastValueShapesProbe || !lastValueShapesProbe.ok || !lastValueShapesProbe.found) {
    log("Run Probe Source Text Value Shapes successfully (with Source Text found) before saving its output.", "error");
    return;
  }
  try {
    const uxp = getUxp();
    // @ts-ignore
    const file = await uxp.storage.localFileSystem.getFileForSaving("mogrt-source-text-value-shapes.json", { types: ["json"] });
    if (!file) return;
    await file.write(JSON.stringify(lastValueShapesProbe, null, 2));
    log(`Value-shapes probe diagnostic saved to ${file.nativePath}.`, "success");
  } catch (err) {
    log(`Saving value-shapes probe JSON failed: ${err.message || err}`, "error");
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

// Picks exactly one of the four user-facing outcome messages for a
// completed sourceTextProbe. Priority: a full write+read-back match beats
// a failed write action, which beats a successful plain read, which beats
// "found but null" — see docs/MOGRT_DIAGNOSTIC.md.
function sourceTextOutcomeMessage(probe) {
  const { valueRead, actionCreation, readBack } = probe;
  if (readBack?.ok && readBack?.matched) {
    return { text: "Source Text write/read-back succeeded.", cls: "log-success" };
  }
  if (actionCreation?.attempted && !actionCreation?.ok) {
    return { text: `Source Text write action could not be created: ${actionCreation.error ?? "unknown error"}`, cls: "log-error" };
  }
  if (valueRead?.workingMethod && valueRead.resolvedValue !== null && valueRead.resolvedValue !== undefined) {
    return { text: `Source Text read successfully via ${valueRead.workingMethod}(): ${JSON.stringify(valueRead.resolvedValue)}`, cls: "log-info" };
  }
  const anyOkRead = (valueRead?.valueGetterAttempts ?? []).some((r) => r.ok) || (valueRead?.getValueAtTimeAttempts ?? []).some((r) => r.ok);
  if (anyOkRead) {
    return { text: "Source Text parameter was found, but Premiere returned null when reading it.", cls: "log-warn" };
  }
  return { text: "Source Text parameter was found, but no read attempt succeeded — see Log for details.", cls: "log-warn" };
}

function sourceTextRoundTripBlock(result, running) {
  if (running) {
    return el("div", { class: "inspector-results" }, [
      el("div", {
        class: "status-line log-info",
        text: "⏳ Running Source Text round trip — inserting a temporary clip, waiting for it to stabilize, reading Source Text, testing a " +
          "non-mutating sentinel keyframe, then (only if that succeeds) writing it and reading it back. The temporary clip is always removed " +
          "afterwards. See Log below for live progress, or click Cancel to stop early.",
      }),
    ]);
  }
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Source Text Round Trip failed${stepLabel}${result.error ? `: ${result.error}` : ""}. See Log below.` }),
    ]);
  }
  if (!result.found) {
    const reasonText =
      result.reason === "no-source-text-param"
        ? "AE.ADBE Text was found, but no param with displayName exactly \"Source Text\" was found on it."
        : "MOGRT component chain did not fully initialise before timeout — AE.ADBE Text was not found within the wait window.";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-warn", text: `⚠ ${reasonText} Temporary clip removed either way. Try again, or check the Log for the discovery timeline.` }),
    ]);
  }
  const probe = result.sourceTextProbe;
  const outcome = sourceTextOutcomeMessage(probe);
  return el("div", { class: "inspector-results" }, [
    el("div", {
      class: "status-line",
      text: `AE.ADBE Text found (component ${probe.componentIndex}), Source Text param at index ${probe.paramIndex} ` +
        `(isTimeVarying: ${String(probe.isTimeVarying)}, areKeyframesSupported: ${String(probe.areKeyframesSupported)}).`,
    }),
    el("div", { class: `status-line ${outcome.cls}`, text: `${outcome.text}` }),
    el("div", {
      class: "status-line",
      text: `createKeyframe: ${
        probe.keyframeCreation.ok
          ? "✓ succeeded" + (probe.keyframeCreation.sentinelPreserved ? " (sentinel preserved)" : "")
          : probe.keyframeCreation.skipped
          ? `— skipped (${probe.keyframeCreation.reason ?? "areKeyframesSupported is false"})`
          : "✗ " + (probe.keyframeCreation.error ?? "failed")
      }` +
        (probe.actionCreation.attempted ? ` — createSetValueAction: ${probe.actionCreation.ok ? "✓ succeeded" : "✗ " + (probe.actionCreation.error ?? "failed")}` : "") +
        (probe.transaction.attempted ? ` — executeTransaction: ${probe.transaction.ok ? "✓ succeeded" : "✗ " + (probe.transaction.error ?? "failed")}` : ""),
    }),
    el("div", { class: "status-line", text: `Temporary clip removed: ${result.cleanupOk ? "yes" : "NO — you may need to delete it from the timeline by hand"}.` }),
  ]);
}

function readSourceTextOnlyOutcomeMessage(valueRead) {
  if (valueRead?.workingMethod && valueRead.resolvedValue !== null && valueRead.resolvedValue !== undefined) {
    return { text: `Source Text read successfully via ${valueRead.workingMethod}(): ${JSON.stringify(valueRead.resolvedValue)}`, cls: "log-success" };
  }
  const anyOkRead = (valueRead?.valueGetterAttempts ?? []).some((r) => r.ok) || (valueRead?.getValueAtTimeAttempts ?? []).some((r) => r.ok);
  if (anyOkRead) {
    return { text: "Source Text parameter was found, but every read method returned null.", cls: "log-warn" };
  }
  return { text: "Source Text parameter was found, but no read method succeeded — see Log for details.", cls: "log-warn" };
}

function readSourceTextOnlyBlock(result, running) {
  if (running) {
    return el("div", { class: "inspector-results" }, [
      el("div", {
        class: "status-line log-info",
        text: "⏳ Reading Source Text only — inserting a temporary clip, waiting for it to stabilize, then trying every non-keyframed value " +
          "getter (getValue(), .value, getStartValue(), any other discovered *value* method, and getValueAtTime(TickTime) as a fallback). " +
          "createKeyframe is never called here. The temporary clip is always removed afterwards. See Log below for live progress, or click " +
          "Cancel to stop early.",
      }),
    ]);
  }
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Read Source Text Only failed${stepLabel}${result.error ? `: ${result.error}` : ""}. See Log below.` }),
    ]);
  }
  if (!result.found) {
    const reasonText =
      result.reason === "no-source-text-param"
        ? "AE.ADBE Text was found, but no param with displayName exactly \"Source Text\" was found on it."
        : "MOGRT component chain did not fully initialise before timeout — AE.ADBE Text was not found within the wait window.";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-warn", text: `⚠ ${reasonText} Temporary clip removed either way. Try again, or check the Log for the discovery timeline.` }),
    ]);
  }
  const outcome = readSourceTextOnlyOutcomeMessage(result.valueRead);
  const methodLines = (result.valueRead?.valueGetterAttempts ?? []).map((a) =>
    el("div", {
      class: "status-line",
      text: `  ${a.name} (${a.kind}, typeof=${a.typeofMember ?? "n/a"}): ${
        a.skipped
          ? `skipped (${a.reason})`
          : a.ok
          ? `✓ ${JSON.stringify(a.resolvedValue)}${a.isPromise ? " (was a Promise)" : ""}`
          : `✗ ${a.error ?? "failed"}`
      }`,
    })
  );
  return el("div", { class: "inspector-results" }, [
    el("div", {
      class: "status-line",
      text: `AE.ADBE Text found (component ${result.componentIndex}), Source Text param at index ${result.paramIndex} ` +
        `(isTimeVarying: ${String(result.isTimeVarying)}, areKeyframesSupported: ${String(result.areKeyframesSupported)}).`,
    }),
    el("div", { class: `status-line ${outcome.cls}`, text: `${outcome.text}` }),
    ...methodLines,
    el("div", { class: "status-line", text: `Temporary clip removed: ${result.cleanupOk ? "yes" : "NO — you may need to delete it from the timeline by hand"}.` }),
  ]);
}

function exploreKeyframeObjectOutcomeMessage(exploration) {
  if (exploration?.workingMethod && exploration.resolvedValue !== null && exploration.resolvedValue !== undefined) {
    return {
      text: `Extracted a value via ${exploration.workingMethod} → ${exploration.workingField}: ${JSON.stringify(exploration.resolvedValue)}`,
      cls: "log-success",
    };
  }
  const anyOk = (exploration?.explorations ?? []).some((e) => e.ok);
  if (anyOk) {
    return { text: "A keyframe object was returned, but no field on it (value/getValue/text/string/sourceText/other) held a usable value.", cls: "log-warn" };
  }
  return { text: "No keyframe exploration path returned an object — see Log for details.", cls: "log-warn" };
}

function exploreKeyframeObjectBlock(result, running) {
  if (running) {
    return el("div", { class: "inspector-results" }, [
      el("div", {
        class: "status-line log-info",
        text: "⏳ Exploring the keyframe API — inserting a temporary clip, waiting for it to stabilize, then trying " +
          "getKeyframeListAsTickTimes(), getKeyframePtr(index), and getKeyframeAtTime(TickTime), dumping the full shape of " +
          "whatever object each one returns. createKeyframe is never called here. The temporary clip is always removed " +
          "afterwards. See Log below for live progress, or click Cancel to stop early.",
      }),
    ]);
  }
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Explore Keyframe Object failed${stepLabel}${result.error ? `: ${result.error}` : ""}. See Log below.` }),
    ]);
  }
  if (!result.found) {
    const reasonText =
      result.reason === "no-source-text-param"
        ? "AE.ADBE Text was found, but no param with displayName exactly \"Source Text\" was found on it."
        : "MOGRT component chain did not fully initialise before timeout — AE.ADBE Text was not found within the wait window.";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-warn", text: `⚠ ${reasonText} Temporary clip removed either way. Try again, or check the Log for the discovery timeline.` }),
    ]);
  }
  const exploration = result.keyframeExploration;
  const outcome = exploreKeyframeObjectOutcomeMessage(exploration);
  const explorationLines = (exploration?.explorations ?? []).map((e) => {
    if (!e.ok) {
      return el("div", { class: "status-line", text: `  ${e.method}${e.args ?? ""}: ✗ ${e.error ?? "failed"}` });
    }
    const fieldSummary = (e.fieldAttempts ?? [])
      .filter((a) => a.ok)
      .map((a) => `${a.name}=${JSON.stringify(a.resolvedValue)}`)
      .join(", ");
    return el("div", {
      class: "status-line",
      text: `  ${e.method}${e.args ?? ""}: ✓ shape=${e.shape?.constructorName ?? "n/a"}${fieldSummary ? `, fields: ${fieldSummary}` : ", no field held a value"}${
        e.workingField ? ` — WORKING FIELD: ${e.workingField}` : ""
      }`,
    });
  });
  return el("div", { class: "inspector-results" }, [
    el("div", {
      class: "status-line",
      text: `AE.ADBE Text found (component ${result.componentIndex}), Source Text param at index ${result.paramIndex} ` +
        `(isTimeVarying: ${String(result.isTimeVarying)}, areKeyframesSupported: ${String(result.areKeyframesSupported)}).`,
    }),
    el("div", { class: "status-line", text: `getKeyframeListAsTickTimes(): ${exploration?.keyframeList?.ok ? `${exploration.keyframeList.count} keyframe time(s) found` : `failed (${exploration?.keyframeList?.error ?? "n/a"})`}` }),
    el("div", { class: `status-line ${outcome.cls}`, text: `${outcome.text}` }),
    ...explorationLines,
    el("div", { class: "status-line", text: `Temporary clip removed: ${result.cleanupOk ? "yes" : "NO — you may need to delete it from the timeline by hand"}.` }),
  ]);
}

const WRITE_PROBE_OUTCOME_MESSAGES = {
  "write-succeeded-and-confirmed": { text: "Write succeeded AND the automated read-back confirms it.", cls: "log-success" },
  "write-api-succeeded-visible-change-unconfirmed": {
    text: "The write API reported success, but the visible/automated change could NOT be confirmed — check the Premiere timeline manually. Reported separately, not assumed either way.",
    cls: "log-warn",
  },
  "write-action-failed": { text: "createSetValueAction(sentinel, true) failed — see Log for the full host error.", cls: "log-error" },
  "transaction-failed": { text: "executeTransaction failed — see Log for the full host error.", cls: "log-error" },
  "write-succeeded-reacquire-failed": { text: "The write transaction succeeded, but re-acquiring the param afterward failed — see Log.", cls: "log-warn" },
};

function writeOnlyProbeBlock(result, running) {
  if (running) {
    return el("div", { class: "inspector-results" }, [
      el("div", {
        class: "status-line log-info",
        text: "⏳ Running the write-only probe — inserting a temporary clip, waiting for it to stabilize, then writing the sentinel " +
          "directly via createSetValueAction() (no read attempted first, no createKeyframe call), waiting briefly, and re-acquiring " +
          "everything fresh to make one best-effort (not authoritative) automated check. Watch the Premiere timeline now for the " +
          "most reliable confirmation — the temporary clip is always removed afterwards. See Log below for live progress, or click " +
          "Cancel to stop early.",
      }),
    ]);
  }
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Write-Only Probe failed${stepLabel}${result.error ? `: ${result.error}` : ""}. See Log below.` }),
    ]);
  }
  if (!result.found) {
    const reasonText =
      result.reason === "no-source-text-param"
        ? "AE.ADBE Text was found, but no param with displayName exactly \"Source Text\" was found on it."
        : "MOGRT component chain did not fully initialise before timeout — AE.ADBE Text was not found within the wait window.";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-warn", text: `⚠ ${reasonText} Temporary clip removed either way. Try again, or check the Log for the discovery timeline.` }),
    ]);
  }
  const probe = result.writeProbe;
  const outcome = WRITE_PROBE_OUTCOME_MESSAGES[probe?.outcome] ?? { text: "Unexpected state — see Log.", cls: "log-warn" };
  return el("div", { class: "inspector-results" }, [
    el("div", {
      class: "status-line",
      text: `createSetValueAction argument: ${JSON.stringify(WRITE_PROBE_SENTINEL)} (typeof ${probe?.write?.argumentType ?? "n/a"}) — ` +
        `${probe?.write?.ok ? `✓ action created${probe.write.actionConstructorName ? ` (${probe.write.actionConstructorName})` : ""}` : `✗ ${probe?.write?.error ?? "failed"}`}.`,
    }),
    probe?.transaction?.attempted
      ? el("div", { class: "status-line", text: `executeTransaction: ${probe.transaction.ok ? "✓ succeeded" : `✗ ${probe.transaction.error ?? "failed"}`}.` })
      : null,
    el("div", { class: `status-line ${outcome.cls}`, text: `${outcome.text}` }),
    probe?.postWrite?.bestEffortRead
      ? el("div", {
          class: "status-line",
          text: `Best-effort automated read-back (not authoritative): ${
            probe.postWrite.automatedCheckConfirmsChange
              ? `✓ ${probe.postWrite.bestEffortRead.workingMethod}() returned the sentinel`
              : `did not confirm the sentinel (workingMethod: ${probe.postWrite.bestEffortRead.workingMethod ?? "none"})`
          }.`,
        })
      : null,
    el("div", { class: "status-line", text: `Temporary clip removed: ${result.cleanupOk ? "yes" : "NO — you may need to delete it from the timeline by hand"}.` }),
  ]);
}

function valueShapesProbeBlock(result, running) {
  if (running) {
    return el("div", { class: "inspector-results" }, [
      el("div", {
        class: "status-line log-info",
        text: "⏳ Probing Source Text value shapes — inserting a temporary clip, waiting for it to stabilize, then trying only value shapes " +
          "grounded in Adobe's official ComponentParam/Keyframe docs (a raw string, the documented { value: X } Keyframe wrapper shape, " +
          "and an existing Keyframe with its documented-Writable .value mutated directly) — never random objects. The temporary clip is " +
          "always removed afterwards. See Log below for live progress, or click Cancel to stop early.",
      }),
    ]);
  }
  if (!result) return null;
  if (!result.ok) {
    const stepLabel = result.step ? ` (step: ${result.step})` : "";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-error", text: `✗ Probe Source Text Value Shapes failed${stepLabel}${result.error ? `: ${result.error}` : ""}. See Log below.` }),
    ]);
  }
  if (!result.found) {
    const reasonText =
      result.reason === "no-source-text-param"
        ? "AE.ADBE Text was found, but no param with displayName exactly \"Source Text\" was found on it."
        : "MOGRT component chain did not fully initialise before timeout — AE.ADBE Text was not found within the wait window.";
    return el("div", { class: "inspector-results" }, [
      el("div", { class: "status-line log-warn", text: `⚠ ${reasonText} Temporary clip removed either way. Try again, or check the Log for the discovery timeline.` }),
    ]);
  }
  const probe = result.valueShapesProbe;
  const confirmed = Boolean(probe?.verifiedWrite?.automatedCheckConfirmsChange);
  const outcomeLine = probe?.workingCandidateName
    ? el("div", {
        class: `status-line ${confirmed ? "log-success" : "log-warn"}`,
        text: confirmed
          ? `✓ Working value shape found: "${probe.workingCandidateName}" — transaction executed and confirmed.`
          : `⚠ "${probe.workingCandidateName}" constructed and executed a transaction, but the automated check couldn't confirm the visible change.`,
      })
    : el("div", {
        class: "status-line log-error",
        text: "✗ None of the documented value shapes were accepted. No text/rich-text wrapper type is documented for ComponentParam in Adobe's " +
          "public reference — this strongly suggests writing native Premiere MOGRT Source Text is not currently supported through the " +
          "documented UXP scripting API.",
      });
  const candidateLines = (probe?.candidates ?? []).map((c) =>
    el("div", {
      class: "status-line",
      text: `  ${c.name}: ${
        !c.attempted
          ? `not attempted (${c.error ?? c.reason ?? "unknown"})`
          : c.ok
          ? `✓ createSetValueAction succeeded (${c.actionConstructorName ?? "action"})`
          : `✗ ${c.error ?? "failed"}`
      }`,
    })
  );
  return el("div", { class: "inspector-results" }, [
    el("div", { class: "status-line", text: `ComponentParam constructor: ${probe?.metadata?.constructorName ?? "n/a"}.` }),
    outcomeLine,
    ...candidateLines,
    el("div", { class: "status-line", text: `Temporary clip removed: ${result.cleanupOk ? "yes" : "NO — you may need to delete it from the timeline by hand"}.` }),
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

  const sourceTextRoundTripBtn = el("button", {
    class: "btn",
    text: ti.sourceTextRoundTripRunning ? "Testing…" : "Test Source Text Round Trip",
    disabled: !isHosted() || ti.sourceTextRoundTripRunning || !ti.mogrtPath || undefined,
    onClick: async () => {
      await runSourceTextRoundTripTest();
      onChange();
    },
  });
  const cancelSourceTextRoundTripBtn = el("button", {
    class: "btn",
    text: "Cancel",
    disabled: !ti.sourceTextRoundTripRunning || undefined,
    onClick: () => cancelSourceTextRoundTrip(),
  });

  const readSourceTextOnlyBtn = el("button", {
    class: "btn",
    text: ti.readSourceTextOnlyRunning ? "Reading…" : "Read Source Text Only",
    disabled: !isHosted() || ti.readSourceTextOnlyRunning || !ti.mogrtPath || undefined,
    onClick: async () => {
      await runReadSourceTextOnlyTest();
      onChange();
    },
  });
  const cancelReadSourceTextOnlyBtn = el("button", {
    class: "btn",
    text: "Cancel",
    disabled: !ti.readSourceTextOnlyRunning || undefined,
    onClick: () => cancelReadSourceTextOnly(),
  });
  const saveReadSourceTextOnlyBtn = el("button", {
    class: "btn",
    text: "Save Source Text read JSON…",
    disabled: !ti.lastReadSourceTextOnly || !ti.lastReadSourceTextOnly.ok || !ti.lastReadSourceTextOnly.found || undefined,
    onClick: () => saveReadSourceTextOnlyJson(),
  });

  const exploreKeyframeObjectBtn = el("button", {
    class: "btn",
    text: ti.exploreKeyframeObjectRunning ? "Exploring…" : "Explore Keyframe Object",
    disabled: !isHosted() || ti.exploreKeyframeObjectRunning || !ti.mogrtPath || undefined,
    onClick: async () => {
      await runExploreKeyframeObjectTest();
      onChange();
    },
  });
  const cancelExploreKeyframeObjectBtn = el("button", {
    class: "btn",
    text: "Cancel",
    disabled: !ti.exploreKeyframeObjectRunning || undefined,
    onClick: () => cancelExploreKeyframeObject(),
  });
  const saveExploreKeyframeObjectBtn = el("button", {
    class: "btn",
    text: "Save keyframe exploration JSON…",
    disabled: !ti.lastExploreKeyframeObject || !ti.lastExploreKeyframeObject.ok || !ti.lastExploreKeyframeObject.found || undefined,
    onClick: () => saveExploreKeyframeObjectJson(),
  });

  const writeOnlyProbeBtn = el("button", {
    class: "btn",
    text: ti.writeOnlyProbeRunning ? "Writing…" : "Write-Only Probe",
    disabled: !isHosted() || ti.writeOnlyProbeRunning || !ti.mogrtPath || undefined,
    onClick: async () => {
      await runWriteOnlyProbeTest();
      onChange();
    },
  });
  const cancelWriteOnlyProbeBtn = el("button", {
    class: "btn",
    text: "Cancel",
    disabled: !ti.writeOnlyProbeRunning || undefined,
    onClick: () => cancelWriteOnlyProbe(),
  });
  const saveWriteOnlyProbeBtn = el("button", {
    class: "btn",
    text: "Save write-only probe JSON…",
    disabled: !ti.lastWriteOnlyProbe || !ti.lastWriteOnlyProbe.ok || !ti.lastWriteOnlyProbe.found || undefined,
    onClick: () => saveWriteOnlyProbeJson(),
  });

  const valueShapesProbeBtn = el("button", {
    class: "btn",
    text: ti.valueShapesProbeRunning ? "Probing…" : "Probe Source Text Value Shapes",
    disabled: !isHosted() || ti.valueShapesProbeRunning || !ti.mogrtPath || undefined,
    onClick: async () => {
      await runValueShapesProbeTest();
      onChange();
    },
  });
  const cancelValueShapesProbeBtn = el("button", {
    class: "btn",
    text: "Cancel",
    disabled: !ti.valueShapesProbeRunning || undefined,
    onClick: () => cancelValueShapesProbe(),
  });
  const saveValueShapesProbeBtn = el("button", {
    class: "btn",
    text: "Save value-shapes probe JSON…",
    disabled: !ti.lastValueShapesProbe || !ti.lastValueShapesProbe.ok || !ti.lastValueShapesProbe.found || undefined,
    onClick: () => saveValueShapesProbeJson(),
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
    el("h3", { text: "Read Source Text Only (troubleshooting)" }),
    el(
      "p",
      { class: "hint" },
      [
        "Read-only, run this before Source Text Round Trip below: locates the AE.ADBE Text component's " +
          "\"Source Text\" param and tries every plausible non-keyframed value getter — getValue(), a plain " +
          "\".value\" property, getStartValue(), any other discovered method whose name contains \"value\", and " +
          "getValueAtTime(TickTime) as a fallback (never called bare). Never calls createKeyframe or anything " +
          "else that could mutate the sequence. Does not require re-running the full Diagnostic Inspector or " +
          "Source Text Round Trip. The temporary clip is always removed afterwards. See docs/MOGRT_DIAGNOSTIC.md.",
      ]
    ),
    el("div", { class: "row" }, [readSourceTextOnlyBtn, cancelReadSourceTextOnlyBtn, saveReadSourceTextOnlyBtn]),
    readSourceTextOnlyBlock(ti.lastReadSourceTextOnly, ti.readSourceTextOnlyRunning),
    el("h3", { text: "Explore Keyframe Object (troubleshooting)" }),
    el(
      "p",
      { class: "hint" },
      [
        "Run this if Read Source Text Only above found no working value getter: a real host run showed " +
          "getValueAtTime() returning the message \"Use GetKeyframeAtTime to get a keyframe object at time. The " +
          "value can be extracted from the keyframe object.\" — this explores that keyframe API specifically. " +
          "Tries getKeyframeListAsTickTimes() to enumerate existing keyframe times, getKeyframePtr(index) at " +
          "every enumerated index, and getKeyframeAtTime(TickTime) with every enumerated time plus a few valid " +
          "fallbacks, then dumps the full shape (every property/method name) of whatever object each call " +
          "returns and checks it for value/getValue/text/string/sourceText fields. Never calls createKeyframe " +
          "or anything else that could mutate the sequence. The temporary clip is always removed afterwards. " +
          "See docs/MOGRT_DIAGNOSTIC.md.",
      ]
    ),
    el("div", { class: "row" }, [exploreKeyframeObjectBtn, cancelExploreKeyframeObjectBtn, saveExploreKeyframeObjectBtn]),
    exploreKeyframeObjectBlock(ti.lastExploreKeyframeObject, ti.exploreKeyframeObjectRunning),
    el("h3", { text: "Write-Only Probe (troubleshooting)" }),
    el(
      "p",
      { class: "hint" },
      [
        `Stops trying to find a working read path. Locates AE.ADBE Text / Source Text exactly as the diagnostics ` +
          `above do, but never reads it first — goes straight to createSetValueAction(${JSON.stringify(WRITE_PROBE_SENTINEL)}, ` +
          "true), passing the sentinel string directly (no createKeyframe call, since that throws for this param). " +
          "Executes the transaction, waits briefly, then re-acquires the TrackItem and Source Text param completely " +
          "fresh and makes one best-effort (NOT authoritative) automated check. Watch the Premiere timeline during " +
          "the wait for the only fully reliable confirmation — if the write API reports success but the automated " +
          "check can't confirm it, that's reported as its own distinct outcome, not assumed either way. The " +
          "temporary clip is always removed afterwards. See docs/MOGRT_DIAGNOSTIC.md.",
      ]
    ),
    el("div", { class: "row" }, [writeOnlyProbeBtn, cancelWriteOnlyProbeBtn, saveWriteOnlyProbeBtn]),
    writeOnlyProbeBlock(ti.lastWriteOnlyProbe, ti.writeOnlyProbeRunning),
    el("h3", { text: "Probe Source Text Value Shapes (troubleshooting)" }),
    el(
      "p",
      { class: "hint" },
      [
        "Run this after Write-Only Probe confirmed createSetValueAction rejects a raw string with \"Illegal Parameter type\". Tries ONLY " +
          "value shapes grounded in Adobe's official ComponentParam/Keyframe/PointKeyframe documentation — never invented objects: (1) a raw " +
          "string, the documented createSetValueAction inValue type; (2) { value: sentinel }, the documented Keyframe.value wrapper shape; " +
          "(3) an existing Keyframe fetched via getKeyframePtr(TickTime) with its documented-Writable .value property mutated directly. " +
          "Whichever candidate succeeds at construction is also executed and given a best-effort read-back check. If none are accepted, " +
          "that's reported plainly — the official docs list no text/rich-text wrapper type at all. The temporary clip is always removed " +
          "afterwards. See docs/MOGRT_DIAGNOSTIC.md.",
      ]
    ),
    el("div", { class: "row" }, [valueShapesProbeBtn, cancelValueShapesProbeBtn, saveValueShapesProbeBtn]),
    valueShapesProbeBlock(ti.lastValueShapesProbe, ti.valueShapesProbeRunning),
    el("h3", { text: "Source Text Round Trip (troubleshooting)" }),
    el(
      "p",
      { class: "hint" },
      [
        "Narrowly scoped: locates the AE.ADBE Text component's \"Source Text\" param (matched by display name, " +
          "not just the last-seen index), reads it with several valid TickTime arguments, tests a non-mutating " +
          "sentinel keyframe, and — only if that succeeds — writes the sentinel and reads it back on the " +
          "temporary inspection clip. Does not touch anything else and does not require re-running the full " +
          "Diagnostic Inspector above. The temporary clip is always removed afterwards. See docs/MOGRT_DIAGNOSTIC.md.",
      ]
    ),
    el("div", { class: "row" }, [sourceTextRoundTripBtn, cancelSourceTextRoundTripBtn]),
    sourceTextRoundTripBlock(ti.lastSourceTextRoundTrip, ti.sourceTextRoundTripRunning),
  ]);
}
