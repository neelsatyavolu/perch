import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyImport, BUNDLED_MESSAGE } from "../../src/import/apply";
import { openBundle, pendingBundles } from "../../src/import/bundle";
import { memoryKeychain } from "../../src/import/keychain";
import type { ImportData } from "../../src/import/types";
import type { ImportApplied, PerchDomainApi } from "../../src/browser/perch-domain";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "perch-apply-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const data: ImportData = {
  passwords: [{ url: "https://a.example/", signonRealm: "https://a.example/", username: "neel", password: "pw-fixture" }],
  searchEngines: [
    { name: "One", keyword: "one", url: "https://one.example/?q={searchTerms}", isDefault: false },
    { name: "Two", keyword: "two", url: "https://two.example/?q={searchTerms}", isDefault: false },
  ],
  addresses: [{ name: "N", organization: "", street: "1 Main", city: "X", state: "CA", zip: "1", country: "US", phone: "", email: "" }],
};
const parts = (Object.keys(data) as (keyof ImportData)[]).map((type) => ({ type, data: { [type]: data[type] } as ImportData }));
const none: ImportApplied = { bookmarks: 0, history: 0, passwords: 0, cookies: 0, tabs: 0, searchEngines: 0 };

type Seen = { path: string; mode: number; json: { data: ImportData } };

function fakeBrowser(answer: (seen: Seen) => Awaited<ReturnType<PerchDomainApi["applyImportBundle"]>> | Error) {
  const seen: Seen[] = [];
  const browser: Pick<PerchDomainApi, "applyImportBundle"> = {
    async applyImportBundle({ path }) {
      const s = { path, mode: statSync(path).mode & 0o777, json: JSON.parse(readFileSync(path, "utf8")) };
      seen.push(s);
      const a = answer(s);
      if (a instanceof Error) throw a;
      return a;
    },
  };
  return { browser, seen };
}

test("the browser applies the bundle from a private temp file that is gone afterwards", async () => {
  const keychain = memoryKeychain();
  const { browser, seen } = fakeBrowser(() => ({ applied: { ...none, passwords: 1, searchEngines: 2 }, skipped: [] }));
  const r = await applyImport({ target: { userDataDir: dir }, keychain, source: { browser: "Chrome", profile: "Default" }, parts, browser });
  expect(seen.length).toBe(1);
  expect(seen[0]!.mode).toBe(0o600);
  expect(seen[0]!.json.data.passwords?.[0]?.username).toBe("neel");
  expect(existsSync(seen[0]!.path)).toBe(false);
  expect(r.results).toEqual([
    { type: "passwords", status: "written", count: 1 },
    { type: "searchEngines", status: "written", count: 2 },
    { type: "addresses", status: "bundled", count: 1, message: BUNDLED_MESSAGE },
  ]);
  // Only what the browser left stays sealed.
  expect(pendingBundles(dir)).toEqual([r.bundle!.id]);
  const left = await openBundle(dir, keychain, r.bundle!.id);
  expect(Object.keys(left.data)).toEqual(["addresses"]);
});

test("a bundle the browser applies in full is discarded with its key", async () => {
  const keychain = memoryKeychain();
  const { browser } = fakeBrowser(() => ({ applied: { ...none, passwords: 1 }, skipped: [] }));
  const r = await applyImport({ target: { userDataDir: dir }, keychain, source: { browser: "Chrome", profile: "Default" }, parts: [parts[0]!], browser });
  expect(r.results).toEqual([{ type: "passwords", status: "written", count: 1 }]);
  expect(r.bundle).toBeUndefined();
  expect(pendingBundles(dir)).toEqual([]);
});

test("types the browser skips stay in the bundle", async () => {
  const keychain = memoryKeychain();
  const { browser } = fakeBrowser(() => ({ applied: { ...none, searchEngines: 2 }, skipped: ["passwords"] }));
  const r = await applyImport({ target: { userDataDir: dir }, keychain, source: { browser: "Chrome", profile: "Default" }, parts: parts.slice(0, 2), browser });
  expect(r.results.map((x) => [x.type, x.status])).toEqual([["passwords", "bundled"], ["searchEngines", "written"]]);
  expect(Object.keys((await openBundle(dir, keychain, r.bundle!.id)).data)).toEqual(["passwords"]);
});

test("a browser without the method keeps today's bundle", async () => {
  const keychain = memoryKeychain();
  const { browser } = fakeBrowser(() => null);
  const r = await applyImport({ target: { userDataDir: dir }, keychain, source: { browser: "Chrome", profile: "Default" }, parts, browser });
  expect(r.results.every((x) => x.status === "bundled")).toBe(true);
  expect(Object.keys((await openBundle(dir, keychain, r.bundle!.id)).data).sort()).toEqual(["addresses", "passwords", "searchEngines"]);
});

test("a failed browser call removes the temp file and leaves everything bundled", async () => {
  const keychain = memoryKeychain();
  const { browser, seen } = fakeBrowser(() => new Error("browser went away"));
  const r = await applyImport({ target: { userDataDir: dir }, keychain, source: { browser: "Chrome", profile: "Default" }, parts, browser });
  expect(existsSync(seen[0]!.path)).toBe(false);
  expect(r.results.every((x) => x.status === "bundled")).toBe(true);
  expect(pendingBundles(dir)).toEqual([r.bundle!.id]);
});
