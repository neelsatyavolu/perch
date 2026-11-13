import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuditLog, type AuditEntry } from "../src/agent/audit";
import { vaultAuditSealer } from "../src/agent/audit-seal";
import { loopRunner } from "../src/app/runner";
import type { RunnerInput } from "../src/app/runs";
import type { Browser } from "../src/browser/browser";
import { fakeModel } from "../src/models/fake";
import { memoryKeychain } from "../src/app/keychain";
import { Vault } from "../src/app/vault";
import { tempProfile } from "./helpers";

const tmp = tempProfile();
afterAll(() => tmp.cleanup());
let n = 0;
const dir = () => {
  const d = join(tmp.dir, `seal-${n++}`);
  mkdirSync(d, { recursive: true });
  return d;
};
const entry = (time: string, extra: Partial<AuditEntry> = {}): AuditEntry => ({ time, tab: "t1", site: "mail.example", action: "type", detail: 'textbox "To" alex@example.com', client: "sidebar", approved: true, result: "ok", ...extra });

test("each record is sealed on its own line, and reads, pages and export still see it", async () => {
  const d = dir();
  const vault = await Vault.open(memoryKeychain(), "Default");
  const log = new AuditLog(join(d, "audit.jsonl"), { sealer: vaultAuditSealer(vault) });
  await log.append(entry("2026-11-01T10:00:00.000Z"));
  await log.append(entry("2026-11-02T10:00:00.000Z", { action: "click" }));
  const raw = readFileSync(join(d, "audit.jsonl"), "utf8");
  expect(raw).not.toContain("alex@example.com");
  expect(raw).not.toContain("mail.example");
  expect(raw.trim().split("\n").every((l) => l.startsWith("enc1:"))).toBe(true);
  expect((await log.entries()).map((e) => e.action)).toEqual(["type", "click"]);
  expect((await log.read({ limit: 1 }))[0]!.action).toBe("click");
  expect((await log.export("jsonl")).text).toContain("alex@example.com");
});

test("older plain lines and lines another writer appended stay readable, in time order with sealed ones", async () => {
  const d = dir();
  const vault = await Vault.open(memoryKeychain(), "Default");
  writeFileSync(join(d, "old.jsonl"), `${JSON.stringify(entry("2026-10-01T00:00:00.000Z", { action: "old" }))}\n`);
  const log = new AuditLog(join(d, "audit.jsonl"), { sealer: vaultAuditSealer(vault), legacy: [join(d, "old.jsonl")] });
  await log.append(entry("2026-11-03T00:00:00.000Z", { action: "new" }));
  writeFileSync(join(d, "audit.jsonl"), `${readFileSync(join(d, "audit.jsonl"), "utf8")}${JSON.stringify(entry("2026-11-04T00:00:00.000Z", { action: "plain" }))}\n`);
  expect((await log.entries()).map((e) => e.action)).toEqual(["old", "new", "plain"]);
});

test("a sealed line under another key, or changed, is skipped rather than failing the log", async () => {
  const d = dir();
  const a = await Vault.open(memoryKeychain(), "Default");
  const b = await Vault.open(memoryKeychain(), "Default");
  await new AuditLog(join(d, "audit.jsonl"), { sealer: vaultAuditSealer(a) }).append(entry("2026-11-01T00:00:00.000Z"));
  const other = new AuditLog(join(d, "audit.jsonl"), { sealer: vaultAuditSealer(b) });
  await other.append(entry("2026-11-02T00:00:00.000Z", { action: "mine" }));
  expect((await other.entries()).map((e) => e.action)).toEqual(["mine"]);
});

test("a private chat's actions are not written to the audit log; a normal chat's are", async () => {
  const d = dir();
  const audit = new AuditLog(join(d, "audit.jsonl"));
  const runner = loopRunner({
    browser: async () => ({}) as Browser,
    model: async () => fakeModel([[{ type: "tool_call", call: { id: "c1", name: "done", args: { answer: "ok" } } }, { type: "done" }]]),
    audit,
  });
  const input = (incognito: boolean) => ({ task: "Look at https://clinic.example/results", settings: { mode: "guard", model: "m", effort: "medium", scope: "current" }, approve: async () => true, signal: new AbortController().signal, incognito }) as unknown as RunnerInput;
  for await (const _ of runner(input(true)));
  expect(await audit.entries()).toEqual([]);
  for await (const _ of runner(input(false)));
  expect((await audit.entries()).map((e) => e.action)).toEqual(["done"]);
});

