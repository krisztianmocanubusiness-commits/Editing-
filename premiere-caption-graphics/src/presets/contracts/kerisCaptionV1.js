/**
 * KERIS_CAPTION_V1 — the first real, buildable MOGRT contract this extension
 * ships against. Human-readable spec + authoring instructions live at
 * /mogrt-contracts/KERIS_CAPTION_V1.md; THIS file is the source of truth the
 * code actually resolves against, so if you edit one, edit both.
 *
 * `requiredParams` and the values of `paramMap` must always be the same 10
 * strings, in the same order, as the "Required exposed params" table in the
 * markdown doc — see test/contracts.test.js for the guard that checks this.
 */
export const KERIS_CAPTION_V1 = {
  id: "KERIS_CAPTION_V1",
  version: 1,
  label: "Keris Caption v1",
  docPath: "mogrt-contracts/KERIS_CAPTION_V1.md",

  // Exact Essential Graphics "Expose" display names a .mogrt must have,
  // verbatim, for this contract. Order matches the markdown spec.
  requiredParams: [
    "Text",
    "Font Size",
    "Fill Color",
    "Position X",
    "Position Y",
    "Background Opacity",
    "Background Color",
    "Tracking",
    "Shadow Opacity",
    "Entrance Style",
  ],

  // Internal preset field key -> exposed param display name, for this
  // contract specifically. Resolved by resolveParamName() in
  // ../mogrtContract.js with lower priority than a preset's own
  // mogrt.paramMap override, and higher priority than the generic
  // CANONICAL_PARAMS fallback.
  paramMap: {
    captionText: "Text",
    fontSize: "Font Size",
    fillColor: "Fill Color",
    positionX: "Position X",
    positionY: "Position Y",
    bgBoxOpacity: "Background Opacity",
    bgBoxColor: "Background Color",
    tracking: "Tracking",
    shadowOpacity: "Shadow Opacity",
    animationStyleIndex: "Entrance Style",
  },
};
