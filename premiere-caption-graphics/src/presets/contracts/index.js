import { KERIS_CAPTION_V1 } from "./kerisCaptionV1.js";

/** Registry of named MOGRT contracts a preset can bind to via `mogrt.contractId`. */
export const CONTRACTS = {
  [KERIS_CAPTION_V1.id]: KERIS_CAPTION_V1,
};

export function getContract(contractId) {
  return CONTRACTS[contractId] ?? null;
}

export { KERIS_CAPTION_V1 };
