/** Chat reasoning efforts, lowest first, and fitting a chosen effort to what a model accepts. */

import type { Effort } from "./protocol";

export const EFFORTS: readonly Effort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export const isEffort = (value: unknown): value is Effort => EFFORTS.includes(value as Effort);

/**
 * The effort to run with: `wanted` when the model accepts it, otherwise the highest effort it
 * accepts below `wanted`, otherwise its lowest. A model that lists no efforts keeps `wanted`.
 */
export function fitEffort(efforts: readonly Effort[] | undefined, wanted: Effort): Effort {
  if (!efforts?.length || efforts.includes(wanted)) return wanted;
  const rank = EFFORTS.indexOf(wanted);
  const below = efforts.filter((e) => EFFORTS.indexOf(e) < rank);
  return below.length ? below.reduce((a, b) => (EFFORTS.indexOf(b) > EFFORTS.indexOf(a) ? b : a)) : efforts[0]!;
}

/** The catalog's efforts for a model, keeping only names Perch knows; the low-to-high trio when it lists none. */
export function catalogEfforts(listed: readonly string[] | undefined): Effort[] {
  const known = (listed ?? []).filter(isEffort);
  return known.length ? known : ["low", "medium", "high"];
}

/** The effort Perch's own loop sends to a model API, which tops out at max. */
export const loopEffort = (effort: Effort): Exclude<Effort, "ultra"> => (effort === "ultra" ? "max" : effort);
