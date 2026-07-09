/**
 * Shared "safely call the host API and report what actually happened"
 * helpers, plus the component/param discovery walk. Originally written for
 * src/ppro/smokeTest.js; extracted here so src/ppro/templateInspector.js can
 * reuse the exact same discovery logic instead of re-implementing it (and
 * risking the two drifting apart).
 */

const MAX_COMPONENT_SCAN = 64;
const MAX_PARAM_SCAN = 64;

export function safe(fn) {
  try {
    return { ok: true, value: fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export async function safeAsync(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: err };
  }
}

export function describeValue(value) {
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Walk every component/param on a track item and log what's actually
 * there — names, best-effort "type", and current value where readable.
 * Scan bounds are defensive: no explicit count method appears in Adobe's
 * public sample (see mogrt.js findExposedParam for the same caveat).
 *
 * @param {import("@adobe/premierepro").TrackItem} trackItem
 * @param {(message: string, level?: string) => void} log
 * @returns {Promise<{ componentIndex: number, paramIndex: number, name: string, type: string, param: object, component: object }[]>}
 */
export async function dumpComponentChain(trackItem, log) {
  log("Reading component chain…", "info");
  const chainResult = await safeAsync(() => trackItem.getComponentChain());
  if (!chainResult.ok) {
    log(`✗ getComponentChain() threw: ${chainResult.error.message || chainResult.error}`, "error");
    return [];
  }
  const chain = chainResult.value;
  if (!chain) {
    log("✗ getComponentChain() returned nothing.", "error");
    return [];
  }

  const discovered = [];
  for (let ci = 0; ci < MAX_COMPONENT_SCAN; ci++) {
    const componentResult = safe(() => chain.getComponentAtIndex(ci));
    if (!componentResult.ok) {
      log(`Component scan stopped at index ${ci}: ${componentResult.error.message || componentResult.error}`, "info");
      break;
    }
    const component = componentResult.value;
    if (!component) {
      log(`Component scan stopped at index ${ci}: no component returned.`, "info");
      break;
    }

    const name = safe(() => component.displayName).value ?? safe(() => component.matchName).value ?? `Component[${ci}]`;
    log(`Component ${ci}: "${name}"`, "info");

    for (let pi = 0; pi < MAX_PARAM_SCAN; pi++) {
      const paramResult = safe(() => component.getParam(pi));
      if (!paramResult.ok || !paramResult.value) break;
      const param = paramResult.value;

      const paramName = safe(() => param.displayName).value ?? `Param[${pi}]`;
      const paramType = safe(() => param.type).value ?? safe(() => param.paramType).value ?? "unknown";
      const startValue = await safeAsync(() => param.getStartValue());
      const currentValueStr = startValue.ok ? describeValue(startValue.value) : `unreadable (${startValue.error.message || startValue.error})`;

      log(`  Param ${pi}: "${paramName}" — type=${paramType}, currentValue=${currentValueStr}`, "info");
      discovered.push({ componentIndex: ci, paramIndex: pi, name: paramName, type: paramType, param, component });
    }
  }

  log(`Component/param scan complete: ${discovered.length} exposed param(s) found.`, discovered.length ? "success" : "warn");
  return discovered;
}
