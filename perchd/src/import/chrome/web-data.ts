/**
 * Chromium's `Web Data` database: custom search engines (`keywords`) and autofill addresses.
 * Addresses moved tables over the years: `autofill_profiles` (old), `local_addresses` (M117+),
 * `addresses` (M123+). All three are read.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { columns, hasTable, withSqliteCopy } from "../sqlite-copy";
import type { Address, SearchEngine } from "../types";

type KeywordRow = { id: number; short_name: string; keyword: string; url: string; suggest_url: string | null; prepopulate_id: number; sync_guid: string | null; starter_pack_id?: number };

function defaultEngineRef(profile: string, db: Database): { guid?: string; id?: number } {
  try {
    const prefs = JSON.parse(readFileSync(join(profile, "Preferences"), "utf8"));
    const guid = prefs?.default_search_provider?.guid ?? prefs?.default_search_provider_data?.template_url_data?.sync_guid;
    if (typeof guid === "string" && guid) return { guid };
  } catch {
    // No Preferences: fall back to Web Data's own record.
  }
  if (!hasTable(db, "meta")) return {};
  const row = db.query("SELECT value FROM meta WHERE key = 'Default Search Provider ID'").get() as { value: string } | null;
  return row ? { id: Number(row.value) } : {};
}

function readEngines(profile: string, db: Database): SearchEngine[] {
  if (!hasTable(db, "keywords")) return [];
  const starter = columns(db, "keywords").has("starter_pack_id") ? ", starter_pack_id" : "";
  const rows = db.query(`SELECT id, short_name, keyword, url, suggest_url, prepopulate_id, sync_guid${starter} FROM keywords`).all() as KeywordRow[];
  const ref = defaultEngineRef(profile, db);
  return rows
    .map((r) => ({ r, isDefault: (ref.guid !== undefined && r.sync_guid === ref.guid) || (ref.id !== undefined && r.id === ref.id) }))
    // Built-in engines come with Perch; bring the ones the user added, and the default.
    .filter(({ r, isDefault }) => isDefault || (r.prepopulate_id === 0 && !r.starter_pack_id))
    .filter(({ r }) => /^https?:\/\//.test(r.url) && r.url.includes("{searchTerms}"))
    .map(({ r, isDefault }) => ({ name: r.short_name, keyword: r.keyword, url: r.url, ...(r.suggest_url ? { suggestUrl: r.suggest_url } : {}), isDefault }));
}

/** Chromium FieldType ids used by the token tables. */
const FIELD = { first: 3, middle: 4, last: 5, full: 7, email: 9, phone: 14, line1: 30, line2: 31, city: 33, state: 34, zip: 35, country: 36, company: 60, street: 77 } as const;

function tokenAddresses(db: Database, table: string, tokens: string): Address[] {
  const rows = db.query(`SELECT a.guid AS guid, t.type AS type, t.value AS value FROM "${table}" a JOIN "${tokens}" t ON t.guid = a.guid`).all() as { guid: string; type: number; value: string }[];
  const byGuid = new Map<string, Map<number, string>>();
  for (const r of rows) {
    const fields = byGuid.get(r.guid) ?? new Map<number, string>();
    fields.set(r.type, r.value ?? "");
    byGuid.set(r.guid, fields);
  }
  return [...byGuid.values()].map((f) => {
    const get = (t: number) => f.get(t) ?? "";
    const name = get(FIELD.full) || [get(FIELD.first), get(FIELD.middle), get(FIELD.last)].filter(Boolean).join(" ");
    const street = get(FIELD.street) || [get(FIELD.line1), get(FIELD.line2)].filter(Boolean).join("\n");
    return { name, organization: get(FIELD.company), street, city: get(FIELD.city), state: get(FIELD.state), zip: get(FIELD.zip), country: get(FIELD.country), phone: get(FIELD.phone), email: get(FIELD.email) };
  });
}

function legacyAddresses(db: Database): Address[] {
  const first = (table: string, col: string) =>
    hasTable(db, table) ? new Map((db.query(`SELECT guid, ${col} AS v FROM ${table}`).all() as { guid: string; v: string }[]).map((r) => [r.guid, r.v ?? ""])) : new Map<string, string>();
  const names = first("autofill_profile_names", "full_name");
  const emails = first("autofill_profile_emails", "email");
  const phones = first("autofill_profile_phones", "number");
  const rows = db.query("SELECT guid, company_name, street_address, city, state, zipcode, country_code FROM autofill_profiles").all() as Record<string, string>[];
  return rows.map((r) => ({
    name: names.get(r.guid!) ?? "",
    organization: r.company_name ?? "",
    street: r.street_address ?? "",
    city: r.city ?? "",
    state: r.state ?? "",
    zip: r.zipcode ?? "",
    country: r.country_code ?? "",
    phone: phones.get(r.guid!) ?? "",
    email: emails.get(r.guid!) ?? "",
  }));
}

function readAddresses(db: Database): Address[] {
  const all = hasTable(db, "addresses") && hasTable(db, "address_type_tokens")
    ? tokenAddresses(db, "addresses", "address_type_tokens")
    : hasTable(db, "local_addresses") && hasTable(db, "local_addresses_type_tokens")
      ? tokenAddresses(db, "local_addresses", "local_addresses_type_tokens")
      : hasTable(db, "autofill_profiles")
        ? legacyAddresses(db)
        : [];
  return all.filter((a) => a.street || a.email || a.phone || a.name);
}

export type WebData = { readonly searchEngines: readonly SearchEngine[]; readonly addresses: readonly Address[] };

export function readChromeWebData(profile: string): Promise<WebData> {
  return withSqliteCopy(join(profile, "Web Data"), (db) => ({ searchEngines: readEngines(profile, db), addresses: readAddresses(db) }));
}
