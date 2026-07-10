import { KERIS_CAPTION_V1_PPRO } from "./kerisCaptionV1Ppro.js";
import { KERIS_CAPTION_V1 } from "./kerisCaptionV1.js";

/**
 * Registry of named MOGRT contracts a preset can bind to via
 * `mogrt.contractId`. Order matters: detectContract() in
 * ../contractValidation.js returns the first exact match by registry
 * order when a template happens to satisfy more than one, so the
 * recommended/default contract for Premiere-authored MOGRTs
 * (KERIS_CAPTION_V1_PPRO) is listed first.
 */
export const CONTRACTS = {
  [KERIS_CAPTION_V1_PPRO.id]: KERIS_CAPTION_V1_PPRO,
  [KERIS_CAPTION_V1.id]: KERIS_CAPTION_V1,
};

export function getContract(contractId) {
  return CONTRACTS[contractId] ?? null;
}

export { KERIS_CAPTION_V1_PPRO, KERIS_CAPTION_V1 };
