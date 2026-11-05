/**
 * Chromium cookies (`Network/Cookies`, or `Cookies` in older profiles). From database
 * version 24 the decrypted value starts with SHA-256(host_key), which is checked and removed.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hasTable, withSqliteCopy } from "../sqlite-copy";
import { fromChromium } from "../time";
import type { Cookie } from "../types";
import { decrypt, type SafeStorageKey } from "./crypto";

type Row = {
  host_key: string;
  name: string;
  value: string;
  encrypted_value: Uint8Array | null;
  path: string;
  expires_utc: number;
  is_secure: number;
  is_httponly: number;
  samesite: number;
  is_persistent: number;
};

export function chromeCookiesPath(profile: string): string | undefined {
  return [join(profile, "Network", "Cookies"), join(profile, "Cookies")].find((p) => existsSync(p));
}

export function countChromeCookies(profile: string): Promise<number> {
  const path = chromeCookiesPath(profile);
  if (!path) return Promise.resolve(0);
  return withSqliteCopy(path, (db) => (db.query("SELECT COUNT(*) AS n FROM cookies").get() as { n: number }).n);
}

const SAME_SITE: Record<number, Cookie["sameSite"]> = { 0: "None", 1: "Lax", 2: "Strict" };

export type CookieResult = { readonly cookies: readonly Cookie[]; readonly undecryptable: number };

export async function readChromeCookies(profile: string, key: SafeStorageKey, now = Date.now()): Promise<CookieResult> {
  const path = chromeCookiesPath(profile);
  if (!path) return { cookies: [], undecryptable: 0 };
  return withSqliteCopy(path, (db) => {
    const version = hasTable(db, "meta") ? Number((db.query("SELECT value FROM meta WHERE key = 'version'").get() as { value: string } | null)?.value ?? 0) : 0;
    const rows = db.query("SELECT host_key, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, samesite, is_persistent FROM cookies").all() as Row[];
    let undecryptable = 0;
    const cookies = rows.flatMap((r): Cookie[] => {
      const expiresMs = r.is_persistent ? fromChromium(r.expires_utc) : undefined;
      if (expiresMs !== undefined && expiresMs <= now) return [];
      const value = r.value || plainValue(key, r, version);
      if (value === undefined) {
        undecryptable++;
        return [];
      }
      return [
        {
          name: r.name,
          value,
          domain: r.host_key,
          path: r.path || "/",
          ...(expiresMs !== undefined ? { expires: Math.floor(expiresMs / 1000) } : {}),
          secure: r.is_secure === 1,
          httpOnly: r.is_httponly === 1,
          ...(SAME_SITE[r.samesite] ? { sameSite: SAME_SITE[r.samesite] } : {}),
        },
      ];
    });
    return { cookies, undecryptable };
  });
}

function plainValue(key: SafeStorageKey, r: Row, version: number): string | undefined {
  const plain = decrypt(key, r.encrypted_value);
  if (plain === undefined) return undefined;
  if (version >= 24 && plain.length >= 32) {
    const hash = createHash("sha256").update(r.host_key).digest();
    if (!plain.subarray(0, 32).equals(hash)) return undefined;
    return plain.subarray(32).toString("utf8");
  }
  return plain.toString("utf8");
}
