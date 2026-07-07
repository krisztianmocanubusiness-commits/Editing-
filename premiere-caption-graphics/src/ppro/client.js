// Single point of contact with the UXP host modules. Wrapped in a try/catch
// so the panel's UI, chunker, and keyword logic can still be exercised
// (and unit-tested with plain Node) outside of a running Premiere Pro host.

let ppro = null;
let uxp = null;

try {
  // eslint-disable-next-line no-undef
  ppro = require("premierepro");
} catch {
  ppro = null;
}

try {
  // eslint-disable-next-line no-undef
  uxp = require("uxp");
} catch {
  uxp = null;
}

export function getPpro() {
  if (!ppro) {
    throw new Error(
      "The 'premierepro' host module isn't available. Run this panel inside " +
        "Premiere Pro via the UXP Developer Tool, not in a browser."
    );
  }
  return ppro;
}

export function getUxp() {
  if (!uxp) {
    throw new Error("The 'uxp' host module isn't available in this environment.");
  }
  return uxp;
}

export function isHosted() {
  return ppro !== null;
}
