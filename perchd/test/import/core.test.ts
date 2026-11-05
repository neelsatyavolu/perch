import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserByKey } from "../../src/import/catalog";
import { chromiumProfiles, detectSources, parseIni } from "../../src/import/detect";
import { macKeychain } from "../../src/import/keychain";
import { withSqliteCopy } from "../../src/import/sqlite-copy";
import { fromChromium, fromMac, toChromium, toMac } from "../../src/import/time";
import { sqlite, tempHome, write } from "./fixtures";

let env: { home: string; cleanup: () => void };
beforeEach(() => (env = tempHome()));
afterEach(() => env.cleanup());

test("timestamps convert both ways", () => {
  const ms = Date.UTC(2026, 10, 5, 8, 30);
  expect(fromChromium(toChromium(ms))).toBe(ms);
  expect(fromMac(toMac(ms))).toBe(ms);
  expect(fromChromium(0)).toBeUndefined();
});

test("the Keychain is asked through `security`, secrets go on stdin, never in arguments", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const codes = [0, 44, 51, 0, 0];
  const keychain = macKeychain(async (args, stdin) => {
    calls.push({ args, stdin });
    return { code: codes[calls.length - 1]!, stdout: "pw-from-keychain\n" };
  });
  expect(await keychain.find("Chrome Safe Storage", "Chrome")).toBe("pw-from-keychain");
  expect(await keychain.find("Nope Safe Storage")).toBeNull();
  await expect(keychain.find("Denied Safe Storage")).rejects.toMatchObject({ reason: "keychain-denied" });
  await keychain.set("Perch Import", "id-1", "c2VjcmV0K2tleT0=");
  await keychain.remove("Perch Import", "id-1");
  expect(calls[0]!.args).toEqual(["find-generic-password", "-w", "-s", "Chrome Safe Storage", "-a", "Chrome"]);
  expect(calls[3]!.args).toEqual(["-i"]);
  expect(calls[3]!.stdin).toContain("c2VjcmV0K2tleT0=");
  expect(calls.flatMap((c) => c.args).join(" ")).not.toContain("c2VjcmV0K2tleT0=");
  await expect(keychain.set("Perch Import", 'x" ; rm', "v")).rejects.toMatchObject({ reason: "invalid" });
});

test("SQLite files are read from a private copy that is removed afterwards", async () => {
  const path = join(env.home, "db.sqlite");
  sqlite(path, "CREATE TABLE t (v); INSERT INTO t VALUES (1);").close();
  let copyDir = "";
  const n = await withSqliteCopy(path, (db) => {
    copyDir = (db.filename ?? "").split("/").slice(0, -1).join("/");
    return (db.query("SELECT COUNT(*) AS n FROM t").get() as { n: number }).n;
  });
  expect(n).toBe(1);
  expect(copyDir.startsWith(tmpdir()) || copyDir.startsWith("/private" + tmpdir())).toBe(true);
  expect(existsSync(copyDir)).toBe(false);
  expect(readdirSync(env.home)).toEqual(["db.sqlite"]);
  await expect(withSqliteCopy(join(env.home, "missing"), () => 1)).rejects.toMatchObject({ reason: "not-found" });
});

test("Chromium profiles come from Local State, or from folders when it is missing; Opera's root is its profile", () => {
  const chrome = browserByKey("chrome")!;
  const root = join(env.home, "Library", "Application Support", "Google", "Chrome");
  write(join(root, "Local State"), JSON.stringify({ profile: { info_cache: { "Profile 3": { name: "Work" }, Default: { name: "Me" }, "../evil": { name: "x" }, Gone: { name: "y" } } } }));
  write(join(root, "Default", "Preferences"), "{}");
  write(join(root, "Profile 3", "Preferences"), "{}");
  expect(chromiumProfiles(root, chrome).map((p) => [p.id, p.name])).toEqual([["Default", "Me"], ["Profile 3", "Work"]]);

  const arcRoot = join(env.home, "Library", "Application Support", "Arc", "User Data");
  write(join(arcRoot, "Default", "Preferences"), "{}");
  write(join(arcRoot, "Profile 1", "Preferences"), "{}");
  write(join(arcRoot, "System Profile", "Preferences"), "{}");
  expect(chromiumProfiles(arcRoot, browserByKey("arc")!).map((p) => p.id)).toEqual(["Default", "Profile 1"]);

  const opera = join(env.home, "Library", "Application Support", "com.operasoftware.Opera");
  write(join(opera, "Preferences"), "{}");
  expect(detectSources(env.home).map((s) => [s.browser.key, s.profiles.map((p) => p.path)])).toEqual([
    ["chrome", [join(root, "Default"), join(root, "Profile 3")]],
    ["arc", [join(arcRoot, "Default"), join(arcRoot, "Profile 1")]],
    ["opera", [opera]],
  ]);
});

test("INI parsing", () => {
  expect(parseIni("; c\n[A]\nk=v=w\n[B]\nx = 1\n")).toEqual({ A: { k: "v=w" }, B: { x: "1" } });
});
