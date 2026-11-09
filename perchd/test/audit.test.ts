import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, csvCell, MAX_ENTRIES, toCsv, type AuditEntry, type AuditSealer } from "../src/agent/audit";
import { AuditMirror, expandAuditPath, PolicyAuditMirror } from "../src/agent/audit-mirror";
import { prepareCall, finishCall } from "../src/agent/session";
import type { ToolContext } from "../src/agent/tools";
import { fixedPolicy, type Policy } from "../src/policy/policy";
import { tempProfile } from "./helpers";

const tmp = tempProfile();
afterAll(() => tmp.cleanup());
let n = 0;
const dir = () => join(tmp.dir, `case-${n++}`);

const entry = (time: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({ time, tab: "t1", site: "example.com", action: "click", client: "cli", approved: null, result: "ok", ...extra });
const lines = (...entries: AuditEntry[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join("");

test("merging three old files keeps every entry once, in time order, and removes them", async () => {
  const d = dir();
  mkdirSync(d, { recursive: true });
  const [a, b, c] = [entry("2026-11-01T10:00:00.000Z"), entry("2026-11-02T10:00:00.000Z", { client: "codex" }), entry("2026-11-03T10:00:00.000Z", { client: "routine:r1" })];
  writeFileSync(join(d, "audit.jsonl"), lines(b));
  writeFileSync(join(d, "mcp-audit.jsonl"), lines(c, a));
  writeFileSync(join(d, "dev-audit.jsonl"), lines(a, b));
  writeFileSync(join(d, "sidebar-audit.jsonl"), `${lines(c)}not json\n`);
  const log = new AuditLog(join(d, "audit.jsonl"), { legacy: ["mcp-audit.jsonl", "dev-audit.jsonl", "sidebar-audit.jsonl", "gone.jsonl"].map((f) => join(d, f)) });
  expect((await log.entries()).map((e) => e.time)).toEqual([a.time, b.time, c.time]);
  for (const f of ["mcp-audit.jsonl", "dev-audit.jsonl", "sidebar-audit.jsonl"]) expect(existsSync(join(d, f))).toBe(false);
  expect(statSync(join(d, "audit.jsonl")).mode & 0o777).toBe(0o600);
});

test("read pages by before, newest first", async () => {
  const log = new AuditLog(join(dir(), "audit.jsonl"));
  for (let day = 1; day <= 5; day++) await log.append(entry(`2026-11-0${day}T10:00:00.000Z`));
  const first = await log.read({ limit: 2 });
  expect(first.map((e) => e.time.slice(8, 10))).toEqual(["05", "04"]);
  const next = await log.read({ limit: 2, before: first[1]!.time });
  expect(next.map((e) => e.time.slice(8, 10))).toEqual(["03", "02"]);
  expect(await log.read({ limit: 0 })).toEqual([]);
});

test("a read opens only the lines added since the last read", async () => {
  let opened = 0;
  const sealer: AuditSealer = { seal: async (t) => Buffer.from(t).toString("base64"), open: async (t) => (opened++, Buffer.from(t, "base64").toString()) };
  const log = new AuditLog(join(dir(), "audit.jsonl"), { sealer });
  for (let day = 1; day <= 3; day++) await log.append(entry(`2026-11-0${day}T10:00:00.000Z`));
  expect(await log.read({ limit: 10 })).toHaveLength(3);
  expect(opened).toBe(3);
  await log.append(entry("2026-11-04T10:00:00.000Z"));
  expect((await log.read({ limit: 10 })).map((e) => e.time.slice(8, 10))).toEqual(["04", "03", "02", "01"]);
  expect(opened).toBe(4);
});

test("the log keeps only the newest MAX_ENTRIES entries", async () => {
  const d = dir();
  mkdirSync(d, { recursive: true });
  const path = join(d, "audit.jsonl");
  const time = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
  writeFileSync(path, Array.from({ length: MAX_ENTRIES + 500 }, (_, i) => `${JSON.stringify(entry(time(i)))}\n`).join(""));
  const log = new AuditLog(path);
  const all = await log.entries();
  expect(all).toHaveLength(MAX_ENTRIES);
  expect(all[0]!.time).toBe(time(500));
  expect((await log.read({ limit: 1 }))[0]!.time).toBe(time(MAX_ENTRIES + 499));
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

test("CSV export guards formulas", async () => {
  expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
  expect(csvCell("+1")).toBe("'+1");
  expect(csvCell("-2")).toBe("'-2");
  expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  expect(csvCell("plain, text")).toBe('"plain, text"');
  const csv = toCsv([entry("2026-11-01T10:00:00.000Z", { detail: "=cmd|' /C calc'!A0", approved: true })]);
  expect(csv.split("\r\n")[1]).toContain(`'=cmd|' /C calc'!A0`);
  const log = new AuditLog(join(dir(), "audit.jsonl"));
  await log.append(entry("2026-11-01T10:00:00.000Z"));
  expect(await log.export("csv")).toMatchObject({ entries: 1 });
  expect((await log.export("jsonl")).text).toBe(lines(entry("2026-11-01T10:00:00.000Z")));
});

test("the mirror creates its folder 0700 and file 0600, and holds exactly the local entry", async () => {
  const d = dir();
  const path = join(d, "company", "logs", "perch.jsonl");
  const mirror = new AuditMirror(path);
  const log = new AuditLog(join(d, "local", "audit.jsonl"), { mirror });
  await log.append(entry("2026-11-01T10:00:00.000Z"));
  expect(statSync(join(d, "company", "logs")).mode & 0o777).toBe(0o700);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(readFileSync(path, "utf8")).toBe(readFileSync(log.path, "utf8"));
  expect(mirror.error()).toBeNull();
  mirror.close();
});

test("a rename of the mirror file is followed by a new file at the same path", async () => {
  const path = join(dir(), "perch.jsonl");
  const mirror = new AuditMirror(path);
  mirror.write(entry("2026-11-01T10:00:00.000Z"));
  renameSync(path, `${path}.1`);
  mirror.write(entry("2026-11-02T10:00:00.000Z"));
  expect(readFileSync(`${path}.1`, "utf8")).toBe(lines(entry("2026-11-01T10:00:00.000Z")));
  expect(readFileSync(path, "utf8")).toBe(lines(entry("2026-11-02T10:00:00.000Z")));
  mirror.close();
});

test("an unwritable path reports an error, the local log still grows, and the mirror retries after a minute", async () => {
  const d = dir();
  const locked = join(d, "locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o500);
  let now = 0;
  const mirror = new AuditMirror(join(locked, "perch.jsonl"), { now: () => now });
  const log = new AuditLog(join(d, "audit.jsonl"), { mirror });
  await log.append(entry("2026-11-01T10:00:00.000Z"));
  await log.append(entry("2026-11-02T10:00:00.000Z"));
  expect((await log.entries()).length).toBe(2);
  expect(mirror.error()).toContain("couldn't write the audit log copy");
  chmodSync(locked, 0o700);
  now = 30_000;
  mirror.write(entry("2026-11-03T10:00:00.000Z"));
  expect(existsSync(join(locked, "perch.jsonl"))).toBe(false);
  now = 61_000;
  mirror.write(entry("2026-11-04T10:00:00.000Z"));
  expect(mirror.error()).toBeNull();
  expect(readFileSync(join(locked, "perch.jsonl"), "utf8")).toBe(lines(entry("2026-11-04T10:00:00.000Z")));
  mirror.close();
});

test("AuditLogPath expands ~/ and ${USER}, and refuses a relative path", () => {
  expect(expandAuditPath("~/Logs/${USER}.jsonl", "/Users/maya", "maya")).toBe("/Users/maya/Logs/maya.jsonl");
  expect(expandAuditPath("/var/log/perch/${USER}/a.jsonl", "/Users/maya", "maya")).toBe("/var/log/perch/maya/a.jsonl");
  expect(expandAuditPath("logs/a.jsonl", "/Users/maya", "maya")).toBeNull();
  expect(expandAuditPath("/var/log/../../etc/a", "/Users/maya", "maya")).toBeNull();
  expect(new AuditMirror("relative.jsonl").error()).toContain("not an absolute path");
});

test("the policy mirror follows AuditLogPath as it changes", async () => {
  const d = dir();
  let policy: Policy = {};
  const mirror = new PolicyAuditMirror({ current: () => policy });
  mirror.write(entry("2026-11-01T10:00:00.000Z"));
  policy = { AuditLogPath: join(d, "a.jsonl") };
  mirror.write(entry("2026-11-02T10:00:00.000Z"));
  policy = { AuditLogPath: join(d, "b.jsonl") };
  mirror.write(entry("2026-11-03T10:00:00.000Z"));
  expect(readFileSync(join(d, "a.jsonl"), "utf8")).toBe(lines(entry("2026-11-02T10:00:00.000Z")));
  expect(readFileSync(join(d, "b.jsonl"), "utf8")).toBe(lines(entry("2026-11-03T10:00:00.000Z")));
  expect(fixedPolicy().current()).toEqual({});
});

/** A tool context with no tab: enough for prepareCall to classify and audit a call. */
const noTab = { tab: null, owned: [], borrowedTabs: [], lastSnapshot: new WeakMap(), shotScale: 1, workDir: "/tmp", close: async () => undefined } as unknown as ToolContext;

test("no entry holds text typed or filled without an approval card showing it", async () => {
  const secrets = ["hunter2", "4111 1111 1111 1111", "=1+1", "Dear Maya, the offer is $120k", "été 🔑 secret"];
  for (const [i, text] of secrets.entries()) {
    const path = join(dir(), "audit.jsonl");
    const mirrorPath = join(dir(), "mirror.jsonl");
    const log = new AuditLog(path, { mirror: new AuditMirror(mirrorPath) });
    for (const mode of ["guard", "skip"] as const) {
      const policy = { mode, audit: log, approve: async () => true, client: "cli" };
      const call = { id: `c${i}`, name: "type", args: { ref: "e1", text } };
      const prepared = await prepareCall(noTab, policy, call);
      if (prepared.kind !== "run") throw new Error("expected a call to run");
      expect(prepared.decision).toBe("run");
      await finishCall(noTab, policy, prepared, null).catch(() => undefined);
    }
    expect((await log.entries()).map((e) => e.action)).toEqual(["type", "type"]);
    const written = readFileSync(path, "utf8") + (existsSync(mirrorPath) ? readFileSync(mirrorPath, "utf8") : "");
    expect(written).not.toContain(text);
    expect(written).not.toContain(JSON.stringify(text).slice(1, -1));
  }
});
