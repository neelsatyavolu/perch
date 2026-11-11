import type { ChatEffort } from "../api";

const ORDER: readonly ChatEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

/** The effort a model runs with: the one asked for if it takes it, else the nearest below, else its lowest (as perchd fits it). */
export function fitEffort(efforts: readonly ChatEffort[], wanted: ChatEffort): ChatEffort {
  if (!efforts.length || efforts.includes(wanted)) return wanted;
  const below = efforts.filter((e) => ORDER.indexOf(e) < ORDER.indexOf(wanted));
  return below.length ? below[below.length - 1]! : efforts[0]!;
}
