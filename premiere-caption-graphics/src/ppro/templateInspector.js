/**
 * Template Inspector: point this at any .mogrt and it tells you, against a
 * real Premiere host, whether it's compliant with the recommended
 * KERIS_CAPTION_V1_PPRO contract (Premiere-only compatible), which
 * required params (if any) are missing, which extra params it exposes
 * beyond the contract, and — checking the whole registry, so this also
 * recognizes a fuller After-Effects-authored KERIS_CAPTION_V1 template —
 * which contract it best matches.
 *
 * This is a read-mostly operation: it inserts the template on the active
 * sequence's topmost video track just long enough to read its exposed
 * params via the component chain, then removes that temporary clip (see
 * removeTrackItem in ./mogrt.js) so inspecting a template doesn't leave
 * clutter on the timeline. If cleanup itself fails, that's reported too —
 * inspection results are still returned, just with a warning that the
 * editor may need to delete the clip by hand.
 */
import { requireActiveProjectAndSequence, getSelectedRangeSeconds, listVideoTracks } from "./timelineRange.js";
import { insertMogrtAt, removeTrackItem } from "./mogrt.js";
import { safeAsync, dumpComponentChain } from "./introspect.js";
import { CONTRACTS, KERIS_CAPTION_V1_PPRO, getContract } from "../presets/contracts/index.js";
import {
  validateAgainstContract,
  detectContract,
  extraParams,
  describeCompliance,
  describeCompatibilityLabel,
} from "../presets/contractValidation.js";

/**
 * @param {Object} opts
 * @param {string} opts.mogrtPath
 * @param {(message: string, level?: string) => void} opts.log
 * @param {{ id: string, requiredParams: string[] }} [opts.targetContract] Defaults to KERIS_CAPTION_V1_PPRO, the recommended contract for Premiere-authored MOGRTs.
 */
export async function inspectMogrt(opts) {
  const { mogrtPath, log, targetContract = KERIS_CAPTION_V1_PPRO } = opts;

  log("════ Template Inspector — start ════", "info");

  if (!mogrtPath) {
    log("✗ No .mogrt selected to inspect.", "error");
    return { ok: false, step: "mogrt-path" };
  }

  let project, sequence;
  try {
    ({ project, sequence } = await requireActiveProjectAndSequence());
  } catch (err) {
    log(`✗ No active project/sequence: ${err.message || err}`, "error");
    log("════ Template Inspector aborted ════", "error");
    return { ok: false, step: "sequence" };
  }

  const tracksResult = await safeAsync(() => listVideoTracks(sequence));
  if (!tracksResult.ok || tracksResult.value.length === 0) {
    log(
      tracksResult.ok
        ? "✗ No video track available to insert a temporary inspection clip onto."
        : `✗ listVideoTracks() threw: ${tracksResult.error.message || tracksResult.error}`,
      "error"
    );
    log("════ Template Inspector aborted ════", "error");
    return { ok: false, step: "track" };
  }
  const videoTrackIndex = tracksResult.value[tracksResult.value.length - 1].index;

  const rangeResult = await safeAsync(() => getSelectedRangeSeconds(sequence));
  const startSec = rangeResult.ok ? rangeResult.value.startSec : 0;

  log(`Inserting temporary inspection clip from: ${mogrtPath}`, "info");
  const insertResult = await safeAsync(() => insertMogrtAt(project, sequence, mogrtPath, startSec, videoTrackIndex, log));
  if (!insertResult.ok) {
    log(`✗ Couldn't insert this .mogrt: ${insertResult.error.message || insertResult.error}`, "error");
    log("════ Template Inspector aborted — nothing to inspect ════", "error");
    return { ok: false, step: "insert" };
  }
  const trackItem = insertResult.value;
  log(`✓ Inserted at ${startSec.toFixed(3)}s on track index ${videoTrackIndex} (temporary, will be removed).`, "success");

  const discovered = await dumpComponentChain(trackItem, log);
  const discoveredNames = discovered.map((d) => d.name);

  const cleanupResult = await safeAsync(() => removeTrackItem(project, sequence, trackItem));
  if (cleanupResult.ok && cleanupResult.value) {
    log("Removed temporary inspection clip.", "info");
  } else {
    log(
      `Couldn't remove the temporary inspection clip (${
        cleanupResult.ok ? "transaction reported failure" : cleanupResult.error.message || cleanupResult.error
      }) — you may need to delete it from the timeline by hand.`,
      "warn"
    );
  }

  const compliance = validateAgainstContract(discoveredNames, targetContract);
  const extras = extraParams(discoveredNames, targetContract);
  const detection = detectContract(discoveredNames, CONTRACTS);
  const detectedContract = detection.detectedContractId ? getContract(detection.detectedContractId) : null;

  log(`${describeCompliance(compliance)} (${describeCompatibilityLabel(targetContract)})`, compliance.isCompliant ? "success" : "error");
  log(`Extra params beyond ${targetContract.id}: ${extras.length ? extras.join(", ") : "none"}`, "info");
  log(
    detectedContract
      ? `Detected contract: ${detectedContract.id} — ${describeCompatibilityLabel(detectedContract)} (exact match).`
      : `Detected contract: none matched exactly (closest: ${detection.bestGuessContractId ?? "n/a"}).`,
    detectedContract ? "success" : "warn"
  );

  log("════ Template Inspector — finished ════", "info");

  return {
    ok: true,
    mogrtPath,
    discoveredNames,
    compliance,
    extraParams: extras,
    detection,
    targetContractId: targetContract.id,
    targetCompatibility: describeCompatibilityLabel(targetContract),
    detectedCompatibility: detectedContract ? describeCompatibilityLabel(detectedContract) : null,
    cleanupOk: cleanupResult.ok && cleanupResult.value === true,
  };
}
