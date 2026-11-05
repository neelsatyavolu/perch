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

export async function applyCookies(conn: CdpConnection, cookies: readonly Cookie[]): Promise<{ applied: number; failed: number }> {
  let applied = 0;
  let failed = 0;
  for (let i = 0; i < cookies.length; i += BATCH) {
    const batch = cookies.slice(i, i + BATCH).map(toCdp);
    try {
      await conn.send("Storage.setCookies", { cookies: batch });
      applied += batch.length;
    } catch {
      // One bad cookie fails the whole call; retry one by one to keep the good ones.
      for (const cookie of batch) {
        try {
          const r = await conn.send<{ success?: boolean }>("Storage.setCookies", { cookies: [cookie] });
          if (r && r.success === false) failed++;
          else applied++;
        } catch {
          failed++;
        }
      }
    }
  }
  return { applied, failed };
}
