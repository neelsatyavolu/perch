import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyExtensionData } from "../../src/import/chrome/extension-data";

const A = "a".repeat(32);
const B = "b".repeat(32);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "perch-extdata-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

test("an extension's settings and database come over, without the source's lock", () => {
  const [from, to] = [join(dir, "from"), join(dir, "to")];
  put(join(from, "Local Extension Settings", A, "000003.log"), "settings");
  put(join(from, "Local Extension Settings", A, "LOCK"), "");
  put(join(from, "IndexedDB", `chrome-extension_${A}_0.indexeddb.leveldb`, "CURRENT"), "db");
  expect(copyExtensionData(from, to, [A, B, "../../etc"])).toEqual([A]);
  expect(readFileSync(join(to, "Local Extension Settings", A, "000003.log"), "utf8")).toBe("settings");
  expect(existsSync(join(to, "Local Extension Settings", A, "LOCK"))).toBe(false);
  expect(readFileSync(join(to, "IndexedDB", `chrome-extension_${A}_0.indexeddb.leveldb`, "CURRENT"), "utf8")).toBe("db");
});

test("an extension Perch already has keeps its own data", () => {
  const [from, to] = [join(dir, "from"), join(dir, "to")];
  put(join(from, "Local Extension Settings", A, "000003.log"), "theirs");
  put(join(to, "Extensions", A, "1.0_0", "manifest.json"), "{}");
  put(join(from, "Local Extension Settings", B, "000003.log"), "theirs");
  put(join(to, "Local Extension Settings", B, "000003.log"), "mine");
  expect(copyExtensionData(from, to, [A, B])).toEqual([]);
  expect(existsSync(join(to, "Local Extension Settings", A))).toBe(false);
  expect(readFileSync(join(to, "Local Extension Settings", B, "000003.log"), "utf8")).toBe("mine");
});
