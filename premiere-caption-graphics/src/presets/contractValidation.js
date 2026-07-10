/**
 * Compares a MOGRT's real, discovered exposed-param names — read from a
 * live Premiere host, see src/ppro/mogrt.js / src/ppro/smokeTest.js — against
 * a named contract's required list. Pure function, no Premiere dependency,
 * so it's unit-testable on its own; the "did we actually read these names
 * off a real template" part happens one layer up, in the smoke test.
 *
 * @param {string[]} discoveredParamNames  Exposed param display names found on a track item.
 * @param {{ id: string, requiredParams: string[] }} contract
 * @returns {{
 *   contractId: string,
 *   isCompliant: boolean,
 *   presentRequired: string[],
 *   missingRequired: string[],
 * }}
 */
export function validateAgainstContract(discoveredParamNames, contract) {
  const discoveredSet = new Set(discoveredParamNames);
  const presentRequired = contract.requiredParams.filter((name) => discoveredSet.has(name));
  const missingRequired = contract.requiredParams.filter((name) => !discoveredSet.has(name));

  return {
    contractId: contract.id,
    isCompliant: missingRequired.length === 0,
    presentRequired,
    missingRequired,
  };
}

/**
 * Human-readable one-liner for logs/UI: exactly which required params are
 * missing, or a clean "compliant" statement. Never leaves the editor
 * guessing which control to add/rename in After Effects.
 */
export function describeCompliance(result) {
  if (result.isCompliant) {
    return `${result.contractId}: COMPLIANT — all ${result.presentRequired.length} required params found.`;
  }
  return (
    `${result.contractId}: NOT COMPLIANT — missing ${result.missingRequired.length} required param(s): ` +
    `${result.missingRequired.join(", ")}. Found: ${result.presentRequired.join(", ") || "none"}.`
  );
}

/**
 * Exposed params a template has that aren't part of a given contract's
 * required list. Not inherently a problem — a template is free to expose
 * more than one contract requires — but worth surfacing to the editor so
 * an unfamiliar template's surface area isn't a mystery.
 *
 * @param {string[]} discoveredParamNames
 * @param {{ requiredParams: string[] }|null} contract  Pass null/undefined to treat every discovered param as "extra".
 */
export function extraParams(discoveredParamNames, contract) {
  if (!contract) return [...discoveredParamNames];
  const required = new Set(contract.requiredParams);
  return discoveredParamNames.filter((name) => !required.has(name));
}

const COMPATIBILITY_LABELS = {
  "premiere-only": "Premiere-only compatible",
  "after-effects": "After Effects / full contract",
};

/**
 * Human-readable compatibility tier for a contract, for surfacing in the
 * Template Inspector: "Premiere-only compatible" (buildable with Premiere's
 * native graphics alone, e.g. KERIS_CAPTION_V1_PPRO) vs. "After Effects /
 * full contract" (needs AE features Premiere's native graphics can't
 * produce, e.g. split Position X/Y or a baked Entrance Style rig, like
 * KERIS_CAPTION_V1).
 *
 * @param {{ compatibility?: string }|null} contract
 */
export function describeCompatibilityLabel(contract) {
  if (!contract) return "Unknown";
  return COMPATIBILITY_LABELS[contract.compatibility] ?? contract.compatibility ?? "Unknown";
}

/**
 * Try to identify which registered contract (if any) a template's real
 * discovered param names satisfy. If more than one contract is fully
 * satisfied, the first exact match (registry order) wins; if none are
 * fully satisfied, reports the closest partial match by required-param
 * coverage so the editor still gets a useful signal instead of a bare "no".
 *
 * @param {string[]} discoveredParamNames
 * @param {Object.<string, { id: string, requiredParams: string[] }>} contracts  Defaults to the full registry.
 */
export function detectContract(discoveredParamNames, contracts) {
  const registry = contracts ?? {};
  const evaluations = Object.values(registry).map((contract) => ({
    contract,
    result: validateAgainstContract(discoveredParamNames, contract),
  }));

  const exactMatch = evaluations.find((e) => e.result.isCompliant);
  if (exactMatch) {
    return {
      detectedContractId: exactMatch.contract.id,
      isExactMatch: true,
      bestGuessContractId: exactMatch.contract.id,
      evaluations,
    };
  }

  const bestGuess = evaluations
    .slice()
    .sort((a, b) => b.result.presentRequired.length - a.result.presentRequired.length)[0];

  return {
    detectedContractId: null,
    isExactMatch: false,
    bestGuessContractId: bestGuess ? bestGuess.contract.id : null,
    evaluations,
  };
}
