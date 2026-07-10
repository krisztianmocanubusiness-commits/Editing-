/**
 * KERIS_CAPTION_V1_PPRO — a Premiere-only-authorable variant of
 * KERIS_CAPTION_V1, for editors without After Effects. Full spec and
 * step-by-step authoring instructions:
 * /mogrt-authoring/PREMIERE_ONLY_GUIDE.md. THIS file is the source of
 * truth the code actually resolves against, so if you edit one, edit both.
 *
 * Differences from KERIS_CAPTION_V1, and why (see the guide for the full
 * research behind each):
 *   - `Position X`/`Position Y` collapse into a single `Position` control.
 *     Premiere does not support "Separate Dimensions" on native graphics —
 *     confirmed via Adobe's own community forum — so split X/Y simply
 *     isn't buildable without After Effects. mogrtContract.js's
 *     flattenPresetForMogrt() detects this contract's combined mapping and
 *     emits one "point"-kind instruction instead of two "number" ones.
 *   - `Entrance Style` is dropped entirely. It requires a custom-named
 *     parameter control plus an expression to conditionally drive other
 *     properties' keyframes — Premiere's native graphics have neither
 *     mechanism. applyChunkToTimeline()'s existing "no baked animation
 *     found" fallback (a plain opacity fade) covers the gap instead, with
 *     zero code changes, *if* `Fill Opacity` is exposed — hence it being
 *     called out below as recommended, not required.
 *
 * This is the RECOMMENDED / DEFAULT contract for Premiere-authored
 * MOGRTs — see ../contracts/index.js (registered first) and
 * src/ppro/smokeTest.js / src/ppro/templateInspector.js (default
 * targetContract). KERIS_CAPTION_V1 remains fully supported for
 * After-Effects-authored templates that can do more (gradients, split
 * position, baked animation rigs).
 */
export const KERIS_CAPTION_V1_PPRO = {
  id: "KERIS_CAPTION_V1_PPRO",
  version: 1,
  label: "Keris Caption v1 (Premiere-only)",
  docPath: "mogrt-authoring/PREMIERE_ONLY_GUIDE.md",
  compatibility: "premiere-only",

  requiredParams: [
    "Text",
    "Font Size",
    "Fill Color",
    "Position",
    "Background Opacity",
    "Background Color",
    "Tracking",
    "Shadow Opacity",
  ],

  // Not required — a template missing this still reports COMPLIANT — but
  // exposing it is what lets applyChunkToTimeline()'s entrance/exit fade
  // fallback actually animate something. See src/ppro/applyCaptions.js.
  recommendedOptionalParams: ["Fill Opacity"],

  paramMap: {
    captionText: "Text",
    fontSize: "Font Size",
    fillColor: "Fill Color",
    fillOpacity: "Fill Opacity",
    // Both keys resolve to the SAME name on purpose — this is what tells
    // flattenPresetForMogrt() (mogrtContract.js) to combine offsetX/offsetY
    // into one "point"-kind instruction rather than two separate "number"
    // ones. See resolveParamName()'s callers there.
    positionX: "Position",
    positionY: "Position",
    bgBoxOpacity: "Background Opacity",
    bgBoxColor: "Background Color",
    tracking: "Tracking",
    shadowOpacity: "Shadow Opacity",
    // animationStyleIndex intentionally omitted — no Entrance Style in
    // this contract; resolves to the generic CANONICAL_PARAMS fallback
    // ("Animation Style"), which a Premiere-only template simply won't
    // have, and applyChunkToTimeline() already handles that gracefully.
  },
};
