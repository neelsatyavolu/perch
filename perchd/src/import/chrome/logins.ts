/**
 * Saved passwords from Chromium's `Login Data` (and `Login Data For Account`, the
 * account-store copy). Counting never decrypts; reading needs the Safe Storage key.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { withSqliteCopy } from "../sqlite-copy";
import { fromChromium } from "../time";
import type { Password } from "../types";
import { decrypt, type SafeStorageKey } from "./crypto";

const FILES = ["Login Data", "Login Data For Account"];
const ROWS = "FROM logins WHERE blacklisted_by_user = 0 AND (origin_url LIKE 'http%' OR signon_realm LIKE 'http%')";

type Row = { origin_url: string; signon_realm: string; username_value: string | null; password_value: Uint8Array | null; date_created: number | null };

export type LoginResult = { readonly passwords: readonly Password[]; readonly undecryptable: number };

function files(profile: string): string[] {
  return FILES.map((f) => join(profile, f)).filter((p) => existsSync(p));
}

export async function countChromeLogins(profile: string): Promise<number> {
  const seen = new Set<string>();
  for (const file of files(profile)) {
    await withSqliteCopy(file, (db) => {
      for (const r of db.query(`SELECT signon_realm, username_value ${ROWS}`).all() as Row[]) seen.add(`${r.signon_realm}\n${r.username_value ?? ""}`);
    });
  }
  return seen.size;
}

export async function readChromeLogins(profile: string, key: SafeStorageKey): Promise<LoginResult> {
  const byKey = new Map<string, Password>();
  let undecryptable = 0;
  for (const file of files(profile)) {
    const rows = await withSqliteCopy(file, (db) => db.query(`SELECT origin_url, signon_realm, username_value, password_value, date_created ${ROWS}`).all() as Row[]);
    for (const r of rows) {
      const plain = decrypt(key, r.password_value);
      if (plain === undefined) {
        undecryptable++;
        continue;
      }
      const username = r.username_value ?? "";
      const id = `${r.signon_realm}\n${username}`;
      if (byKey.has(id)) continue;
      byKey.set(id, { url: r.origin_url || r.signon_realm, signonRealm: r.signon_realm, username, password: plain.toString("utf8"), created: fromChromium(r.date_created ?? 0) });
    }
  }
  return { passwords: [...byKey.values()], undecryptable };
}
