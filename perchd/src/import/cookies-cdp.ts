/**
 * Apply imported cookies to a running Perch over the DevTools pipe perchd already holds, so a
 * cookie import needs no restart and the values never touch disk outside Chromium's own
 * encrypted cookie store.
 */

import type { CdpConnection } from "../cdp/connection";
import type { Cookie } from "./types";

const BATCH = 100;

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
    ...(c.partition ? { partitionKey: { topLevelSite: c.partition.site, hasCrossSiteAncestor: c.partition.crossSite } } : {}),
  };
}

/**
 * Chromium sometimes gives no answer to a setCookies call, and the same cookies go in fine a moment
 * later. So a call that stays silent this long is set aside and tried once more after the other
 * batches; an import never waits on one call for long.
 */
const TIMEOUT_MS = 3_000;

/**
 * Chromium keeps about 3,300 cookies and throws out the least recently used beyond that, so sending
 * more only makes it evict as it goes. Readers list the most recently used first; the import keeps
 * this many and counts the rest as left out.
 */
export const MAX_COOKIES = 3_000;

class Silent extends Error {}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const silent = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Silent("no answer")), ms);
  });
  return Promise.race([promise, silent]).finally(() => clearTimeout(timer));
}

type Wire = Record<string, unknown>;

/** Sets one batch. A refused batch is retried cookie by cookie; a silent one is handed back. */
async function setBatch(conn: CdpConnection, batch: readonly Wire[], timeoutMs: number): Promise<{ applied: number; failed: number; silent: readonly Wire[] }> {
  try {
    await within(conn.send("Storage.setCookies", { cookies: batch }), timeoutMs);
    return { applied: batch.length, failed: 0, silent: [] };
  } catch (error) {
    if (error instanceof Silent) return { applied: 0, failed: 0, silent: batch };
  }
  // One bad cookie fails the whole call; go one by one to keep the good ones.
  let applied = 0;
  let failed = 0;
  for (const [index, cookie] of batch.entries()) {
    try {
      const r = await within(conn.send<{ success?: boolean }>("Storage.setCookies", { cookies: [cookie] }), timeoutMs);
      if (r && r.success === false) failed++;
      else applied++;
    } catch (error) {
      if (error instanceof Silent) return { applied, failed, silent: batch.slice(index) };
      failed++;
    }
  }
  return { applied, failed, silent: [] };
}

export async function applyCookies(conn: CdpConnection, cookies: readonly Cookie[], timeoutMs = TIMEOUT_MS, now = Date.now()): Promise<{ applied: number; failed: number }> {
  // A cookie that has already run out would be dropped by the browser anyway.
  const current = cookies.filter((c) => c.expires === undefined || c.expires * 1000 > now);
  const live = current.slice(0, MAX_COOKIES).map(toCdp);
  let applied = 0;
  let failed = current.length - live.length;
  let later: Wire[] = [];
  for (let i = 0; i < live.length; i += BATCH) {
    const r = await setBatch(conn, live.slice(i, i + BATCH), timeoutMs);
    applied += r.applied;
    failed += r.failed;
    later = [...later, ...r.silent];
  }
  // One more try for what got no answer; what is silent twice is left out.
  for (let i = 0; i < later.length; i += BATCH) {
    const r = await setBatch(conn, later.slice(i, i + BATCH), timeoutMs);
    applied += r.applied;
    failed += r.failed + r.silent.length;
  }
  return { applied, failed };
}
