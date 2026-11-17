import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryKeychain } from "../src/app/keychain";
import { TranscriptStore } from "../src/app/debug-transcripts";
import { Vault } from "../src/app/vault";
import { clipMiddle } from "../src/agent/debug-transcript";

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-transcripts-"));
  vault = await Vault.open(memoryKeychain(), "Default");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = (limits = {}) => TranscriptStore.open(dir, vault, limits);

test("a run's events are read back in order", async () => {
  const s = await store();
  const w = s.writer("chat-1");
  w.record({ kind: "run", runId: "r1", task: "Find flights", model: "claude-opus-5-5", mode: "guard" });
  w.record({ kind: "turn", ms: 900, text: "Looking", calls: [{ id: "c1", name: "navigate", args: { url: "https://example.com" } }] });
  w.record({ kind: "tool", id: "c1", name: "navigate", ms: 300, approved: null, error: false, content: "Page: Example" });
  w.record({ kind: "end", outcome: "final", text: "Done", ms: 1500 });
  await w.flush();
  const events = await s.read("chat-1");
  expect(events.map((e) => e.kind)).toEqual(["run", "turn", "tool", "end"]);
  expect(events[2]).toMatchObject({ name: "navigate", content: "Page: Example" });
  expect(typeof events[0]!.time).toBe("string");
});

test("the file on disk is sealed: no page text in it", async () => {
  const s = await store();
  const w = s.writer("chat-1");
  w.record({ kind: "tool", id: "c1", name: "snapshot", ms: 1, approved: null, error: false, content: "secret page words" });
  await w.flush();
  const [file] = readdirSync(dir);
  expect(readFileSync(join(dir, file!), "utf8")).not.toContain("secret");
  expect(statSync(join(dir, file!)).mode & 0o777).toBe(0o600);
});

test("a long page is compressed well below its size", async () => {
  const s = await store();
  const w = s.writer("chat-1");
  const page = "row of a long results table with repeated words\n".repeat(400);
  w.record({ kind: "tool", id: "c1", name: "snapshot", ms: 1, approved: null, error: false, content: page });
  await w.flush();
  const [file] = readdirSync(dir);
  expect(statSync(join(dir, file!)).size).toBeLessThan(page.length / 5);
});

test("a chat's transcript is removed with it", async () => {
  const s = await store();
  const w = s.writer("chat-1");
  w.record({ kind: "end", outcome: "error", text: "not found", ms: 5 });
  await w.flush();
  await s.remove("chat-1");
  expect(await s.read("chat-1")).toEqual([]);
});

test("old transcripts go first, then the oldest until under the size cap", async () => {
  const s = await store({ maxAgeMs: 30 * 86_400_000, maxBytes: 1_000 });
  const now = Date.now();
  writeFileSync(join(dir, "old.ptr"), "x");
  utimesSync(join(dir, "old.ptr"), new Date(now - 31 * 86_400_000), new Date(now - 31 * 86_400_000));
  writeFileSync(join(dir, "a.ptr"), "x".repeat(600));
  utimesSync(join(dir, "a.ptr"), new Date(now - 2_000), new Date(now - 2_000));
  writeFileSync(join(dir, "b.ptr"), "x".repeat(600));
  await s.prune(now);
  expect(readdirSync(dir).sort()).toEqual(["b.ptr"]);
});

test("a deleted chat's transcript goes at the next prune", async () => {
  const s = await store({ isLive: (id: string) => id !== "gone" });
  writeFileSync(join(dir, "gone.ptr"), "x");
  writeFileSync(join(dir, "kept.ptr"), "x");
  await s.prune();
  expect(readdirSync(dir)).toEqual(["kept.ptr"]);
});

test("a chat id that is not a plain id is refused", async () => {
  const s = await store();
  expect(() => s.writer("../escape")).toThrow();
});

test("clipMiddle keeps the start and the end", () => {
  const text = `${"a".repeat(10)}${"b".repeat(100)}${"c".repeat(10)}`;
  const clipped = clipMiddle(text, 10, 10);
  expect(clipped.startsWith("a".repeat(10))).toBe(true);
  expect(clipped.endsWith("c".repeat(10))).toBe(true);
  expect(clipped).toContain("100 characters left out");
});
