import { getPpro } from "./client.js";

/** Seconds -> TickTime, per Adobe sample usage (`ppro.TickTime.createWithSeconds`). */
export function secToTick(seconds) {
  const ppro = getPpro();
  return ppro.TickTime.createWithSeconds(seconds);
}

/** TickTime -> seconds. */
export function tickToSec(tickTime) {
  return tickTime.seconds;
}
