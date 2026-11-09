/**
 * Apply imported cookies to a running Perch over the DevTools pipe perchd already holds, so a
 * cookie import needs no restart and the values never touch disk outside Chromium's own
 * encrypted cookie store.
 */

import type { CdpConnection } from "../cdp/connection";
import type { Cookie } from "./types";

const BATCH = 200;

function toCdp(c: Cookie): Record<string, unknown> {
  // Chromium refuses SameSite=None without Secure; such a cookie falls back to the default.
  const sameSite = c.sameSite === "None" && !c.secure ? undefined : c.sameSite;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: c.secure,
    httpOnly: c.httpOnly,
    ...(sameSite ? { sameSite } : {}),
    ...(c.expires !== undefined ? { expires: c.expires } : {}),
  };
}

/** Chromium sometimes never answers a large setCookies call; a call that stays silent this long counts as failed. */
const BATCH_TIMEOUT_MS = 15_000;
const ONE_TIMEOUT_MS = 4_000;
/** After this many silent single calls in a row, the rest of the batch is given up on. */
const MAX_SILENT = 3;

class Silent extends Error {}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Silent("no answer")), ms);
  });
  return Promise.race([promise, silent]).finally(() => clearTimeout(timer));
}

export async function applyCookies(
  conn: CdpConnection,
  cookies: readonly Cookie[],
  timeouts: { readonly batch: number; readonly one: number } = { batch: BATCH_TIMEOUT_MS, one: ONE_TIMEOUT_MS },
): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (let i = 0; i < cookies.length; i += BATCH) {
    const batch = cookies.slice(i, i + BATCH).map(toCdp);
    try {
      await within(conn.send("Storage.setCookies", { cookies: batch }), timeouts.batch);
      applied += batch.length;
    } catch {
      // One bad cookie fails the whole call, and some calls are never answered; retry one by one to keep the good ones.
      let silent = 0;
      for (const [index, cookie] of batch.entries()) {
        if (silent >= MAX_SILENT) {
          failed += batch.length - index;
          break;
        }
        try {
          const r = await within(conn.send<{ success?: boolean }>("Storage.setCookies", { cookies: [cookie] }), timeouts.one);
          silent = 0;
          if (r && r.success === false) failed++;
          else applied++;
        } catch (error) {
          silent = error instanceof Silent ? silent + 1 : 0;
          failed++;
        }
      }
    }
  }
  return { applied, failed };
}
