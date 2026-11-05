/** Timestamp conversions between the formats browsers store and Unix milliseconds. */

/** Microseconds between 1601-01-01 (Chromium/Windows epoch) and 1970-01-01. */
const CHROMIUM_EPOCH_OFFSET_US = 11_644_473_600_000_000n;
/** Seconds between 1970-01-01 and 2001-01-01 (Core Data / Mac absolute time). */
const MAC_EPOCH_OFFSET_S = 978_307_200;

export function fromChromium(us: number | bigint | null | undefined): number | undefined {
  if (us === null || us === undefined) return undefined;
  const v = BigInt(us);
  if (v <= 0n) return undefined;
  return Number((v - CHROMIUM_EPOCH_OFFSET_US) / 1000n);
}

export function toChromium(ms: number): bigint {
  return BigInt(Math.round(ms)) * 1000n + CHROMIUM_EPOCH_OFFSET_US;
}

/** Safari's History.db and plist dates: seconds since 2001, as a float. */
export function fromMac(seconds: number | null | undefined): number | undefined {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return undefined;
  return Math.round((seconds + MAC_EPOCH_OFFSET_S) * 1000);
}

export function toMac(ms: number): number {
  return ms / 1000 - MAC_EPOCH_OFFSET_S;
}

/** Firefox stores microseconds since 1970. */
export function fromUnixMicros(us: number | null | undefined): number | undefined {
  if (us === null || us === undefined || us <= 0) return undefined;
  return Math.round(us / 1000);
}
