/**
 * Pure classification logic for a raw CSInterface.evalScript() callback
 * result. Deliberately has ZERO browser/CEP dependencies (no `document`,
 * no `CSInterface`) so it can be unit-tested directly under plain Node —
 * unlike the rest of cep-bridge/client/main.js, which needs a real CEP
 * panel's browser context to run at all.
 *
 * Real-host bug this exists to fix: the previous /raw-eval implementation
 * attempted JSON.parse() on every raw callback and treated a parse
 * failure as informative-only, but a caller-side logging line still
 * summarized the whole request as "finished with errors" whenever the
 * transport-level `ok` flag it computed was anything but a clean success
 * — and every one of the bypass test scripts (including a bare literal
 * with zero ExtendScript dependency) was being funneled through that same
 * ambiguous path. The fix: classify a raw result as an ExtendScript-side
 * failure ONLY when it is EXACTLY the literal "EvalScript error." string
 * — never because the text "isn't JSON" (most of the bypass scripts
 * intentionally don't return JSON at all — e.g. a bare helper function
 * returning a plain string like "c") — and never JSON.parse() it here at
 * all (task 2/5).
 *
 * @param {string | undefined} resultString - exactly what
 *   CSInterface.evalScript()'s callback received, unmodified.
 * @returns {{ok: boolean, rawResult: string | null, rawResultType: string, rawResultLength: number, isEvalScriptError: boolean}}
 */
function classifyRawEvalResult(resultString) {
  const rawResultType = typeof resultString;
  const rawResult = resultString === undefined ? null : resultString;
  const rawResultLength = rawResult === null ? 0 : String(rawResult).length;
  const isEvalScriptError = resultString === "EvalScript error.";
  return {
    ok: !isEvalScriptError,
    rawResult,
    rawResultType,
    rawResultLength,
    isEvalScriptError,
  };
}

module.exports = { classifyRawEvalResult };
