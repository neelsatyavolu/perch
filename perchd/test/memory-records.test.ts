import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mockKeychain } from "../src/memory/keychain";
import { newPage, parsePage, renderPage } from "../src/memory/page";
import { RecordFolder } from "../src/memory/records";
import { categoryOf, cleanText, looksSecret, pagePath } from "../src/memory/sanitize";

const dirs: string[] = [];
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "perch-mem-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

test("paths: each category files pages in its own folder; USER.md and MEMORY.md sit at the top", () => {
  expect(pagePath("user", "Me")).toBe("USER.md");
  expect(pagePath("rules", "Rules")).toBe("MEMORY.md");
  expect(pagePath("people", "Maya Chen (sister)")).toBe("people/maya-chen-sister.md");
  expect(pagePath("sites", "github.com")).toBe("sites/github-com.md");
  expect(categoryOf("people/maya-chen.md")).toBe("people");
  expect(categoryOf("USER.md")).toBe("user");
  expect(categoryOf("../etc/passwd")).toBeNull();
  expect(categoryOf("people/../x.md")).toBeNull();
  expect(categoryOf("weird/x.md")).toBeNull();
});

test("cleanText keeps one plain line and strips comment markers", () => {
  expect(cleanText("  Likes\n\n  <!-- tea -->  ")).toBe("Likes tea");
  expect(cleanText("x".repeat(900)).length).toBe(500);
});

test("looksSecret catches passwords, keys, card numbers and codes, not ordinary facts", () => {
  for (const s of [
    "My Gmail password is hunter22",
    "API key sk-proj-abcdefghijklmnopqrstuvwx",
    "card 4111 1111 1111 1111",
    "the verification code: 829114",
    "AWS key AKIAIOSFODNN7EXAMPLE",
    "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "SSN 123-45-6789",
  ]) expect([s, looksSecret(s)]).toEqual([s, true]);
  for (const s of ["Prefers aisle seats", "Phone 650 555 0134 is the work line", "Lives in Palo Alto", "Uses 1Password for passwords", "Order 112-4455661-2231 arrived"]) {
    expect([s, looksSecret(s)]).toEqual([s, false]);
  }
});

test("a page round-trips through markdown with dates, sources and expiry", () => {
  const page = {
    ...newPage("people/maya-chen.md", "Maya Chen", "2026-11-05T10:00:00.000Z"),
    current: [
      { text: "Designer at Chen Studio", added: "2026-11-05T10:00:00.000Z", source: "chat" as const },
      { text: "In Lisbon until Dec 1", added: "2026-11-05T10:00:00.000Z", source: "setup" as const, expires: "2026-12-01" },
    ],
    history: [{ text: "Worked at IDEO", added: "2025-01-02T00:00:00.000Z", source: "user" as const }],
  };
  const md = renderPage(page);
  expect(md).toContain("# Maya Chen");
  expect(md).toContain("## Current\n- Designer at Chen Studio <!-- added=2026-11-05T10:00:00.000Z source=chat -->");
  expect(parsePage(md)).toEqual(page);
});

test("a hand-edited page without annotations still parses", () => {
  const md = "---\nid: 00112233445566778899aabbccddeeff\npath: USER.md\ntitle: About me\ncreated: 2026-11-01T00:00:00.000Z\nupdated: 2026-11-02T00:00:00.000Z\n---\n# About me\n\n## Current\n- Name is Neel\n";
  const page = parsePage(md);
  expect(page.category).toBe("user");
  expect(page.current).toEqual([{ text: "Name is Neel", added: "2026-11-02T00:00:00.000Z", source: "user" }]);
});

test("records are encrypted, private, written atomically and read back", async () => {
  const dir = tempDir();
  const folder = await RecordFolder.open(dir, mockKeychain(), "default");
  await folder.put("pages", "00112233445566778899aabbccddeeff", "CANARY-Maya-Chen-Lisbon");
  expect(await folder.get("pages", "00112233445566778899aabbccddeeff")).toBe("CANARY-Maya-Chen-Lisbon");
  expect(await folder.ids("pages")).toEqual(["00112233445566778899aabbccddeeff"]);
  const files = walk(dir);
  expect(files.map((f) => f.slice(dir.length))).toEqual(["/pages/00112233445566778899aabbccddeeff.prc"]);
  for (const f of files) {
    expect(readFileSync(f).includes(Buffer.from("CANARY"))).toBe(false);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  }
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  await folder.remove("pages", "00112233445566778899aabbccddeeff");
  expect(await folder.ids("pages")).toEqual([]);
  expect(await folder.get("pages", "00112233445566778899aabbccddeeff")).toBeNull();
});

test("a damaged record is skipped and reported; the others still load", async () => {
  const dir = tempDir();
  const folder = await RecordFolder.open(dir, mockKeychain(), "default");
  await folder.put("pages", "aa".repeat(16), "good");
  await folder.put("pages", "bb".repeat(16), "bad");
  writeFileSync(join(dir, "pages", `${"bb".repeat(16)}.prc`), "garbage");
  const { records, damaged } = await folder.all("pages");
  expect(records).toEqual([{ id: "aa".repeat(16), text: "good" }]);
  expect(damaged).toEqual(["bb".repeat(16)]);
});

test("opening existing records without the key fails instead of making a new key", async () => {
  const dir = tempDir();
  const folder = await RecordFolder.open(dir, mockKeychain(), "default");
  await folder.put("pages", "aa".repeat(16), "x");
  await expect(RecordFolder.open(dir, mockKeychain(), "default")).rejects.toThrow("missing from the Keychain");
});

test("ids and kinds are checked, so no path escapes the folder", async () => {
  const folder = await RecordFolder.open(tempDir(), mockKeychain(), "default");
  await expect(folder.put("pages", "../../x", "x")).rejects.toThrow("record id");
  await expect(folder.put("../x", "aa".repeat(16), "x")).rejects.toThrow("record kind");
});
