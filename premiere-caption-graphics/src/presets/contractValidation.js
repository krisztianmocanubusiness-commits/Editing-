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
