/**
 * Password CSV files, as exported by Safari and the Passwords app, Chrome, Firefox (about:logins),
 * Edge, Brave and most password managers. Columns are found by header name.
 */

import { ImportError, type Password } from "../types";

const URL_COLS = ["url", "login_uri", "website", "web site", "origin", "hostname", "login url"];
const USER_COLS = ["username", "login_username", "user", "login", "email", "user name"];
const PASS_COLS = ["password", "login_password"];
const NOTE_COLS = ["notes", "note", "comments"];
const MAX_BYTES = 20 * 1024 * 1024;

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) rows.push([...row, field]);
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function origin(url: string): string | undefined {
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === "https:" || u.protocol === "http:" ? `${u.protocol}//${u.host}/` : undefined;
  } catch {
    return undefined;
  }
}

export type CsvResult = { readonly passwords: readonly Password[]; readonly skipped: number };

export function parsePasswordsCsv(text: string): CsvResult {
  if (text.length > MAX_BYTES) throw new ImportError("This password file is larger than 20 MB, which is more than any browser export.", "invalid");
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ""));
  const names = (header ?? []).map((h) => h.trim().toLowerCase());
  const col = (options: string[]) => names.findIndex((n) => options.includes(n));
  const [u, n, p, note] = [col(URL_COLS), col(USER_COLS), col(PASS_COLS), col(NOTE_COLS)];
  if (u < 0 || p < 0) throw new ImportError("This file has no URL and password columns. Export passwords as CSV from the other browser or app and choose that file.", "invalid");
  let skipped = 0;
  const seen = new Set<string>();
  const passwords = rows.flatMap((r): Password[] => {
    const url = (r[u] ?? "").trim();
    const realm = origin(url);
    const password = r[p] ?? "";
    const username = n >= 0 ? (r[n] ?? "").trim() : "";
    if (!realm || !password) {
      skipped++;
      return [];
    }
    const id = `${realm}\n${username}`;
    if (seen.has(id)) return [];
    seen.add(id);
    const text = note >= 0 ? (r[note] ?? "").trim() : "";
    return [{ url: /^[a-z]+:\/\//i.test(url) ? url : realm, signonRealm: realm, username, password, ...(text ? { note: text } : {}) }];
  });
  return { passwords, skipped };
}
