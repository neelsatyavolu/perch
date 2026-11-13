import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStaleWorkFolders } from "../src/agent/stale-folders";

const root = mkdtempSync(join(tmpdir(), "perch-stale-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("chat and exec folders untouched for a day are removed at startup; newer ones and others stay", () => {
  const now = Date.now();
  const old = (now - 25 * 60 * 60_000) / 1000;
  const make = (name: string, age?: number) => {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(join(path, "notes.pdf"), "x");
    if (age !== undefined) utimesSync(path, age, age);
    return path;
  };
  const staleChat = make("perch-chat-old", old);
  const staleExec = make("perch-exec-old", old);
  const fresh = make("perch-chat-new");
  const other = make("someone-else", old);
  expect(removeStaleWorkFolders(root, now)).toBe(2);
  expect([existsSync(staleChat), existsSync(staleExec), existsSync(fresh), existsSync(other)]).toEqual([false, false, true, true]);
  expect(removeStaleWorkFolders(join(root, "missing"), now)).toBe(0);
});
