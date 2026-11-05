import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatStore, DEFAULT_SETTINGS } from "../src/app/chats";
import { memoryKeychain } from "../src/app/keychain";
import { Vault } from "../src/app/vault";

let dir: string;
let vault: Vault;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-chats-"));
  vault = await Vault.open(memoryKeychain(), "Default");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const store = () => ChatStore.load(join(dir, "chats"), vault);
const say = (text: string, role: "user" | "assistant" = "user") => ({ id: crypto.randomUUID(), role, text, time: new Date().toISOString() });

test("a chat survives a reload", async () => {
  const a = await store();
  const chat = await a.create({ title: "Plan the trip" });
  await a.update(chat.id, (c) => ({ ...c, messages: [...c.messages, say("Find flights to Tokyo")] }));
  const b = await store();
  const again = b.get(chat.id)!;
  expect(again.title).toBe("Plan the trip");
  expect(again.messages.map((m) => m.text)).toEqual(["Find flights to Tokyo"]);
  expect(again.settings).toEqual(DEFAULT_SETTINGS);
});

test("files on disk hold no plaintext and only the owner can read them", async () => {
  const a = await store();
  const chat = await a.create({ title: "Private title" });
  await a.update(chat.id, (c) => ({ ...c, messages: [say("my card ends in 4242")] }));
  const files = readdirSync(join(dir, "chats"));
  expect(files).toHaveLength(1);
  const raw = readFileSync(join(dir, "chats", files[0]!)).toString("latin1");
  expect(raw).not.toContain("Private title");
  expect(raw).not.toContain("4242");
  expect(statSync(join(dir, "chats", files[0]!)).mode & 0o777).toBe(0o600);
  expect(statSync(join(dir, "chats")).mode & 0o777).toBe(0o700);
});

test("updates return new objects and leave earlier ones unchanged", async () => {
  const a = await store();
  const before = await a.create({});
  const after = await a.update(before.id, (c) => ({ ...c, draft: "half a thought" }));
  expect(before.draft).toBe("");
  expect(after.draft).toBe("half a thought");
  expect(after).not.toBe(before);
});

test("list puts the newest chat first", async () => {
  const a = await store();
  const one = await a.create({ title: "one" });
  await Bun.sleep(5);
  await a.create({ title: "two" });
  await Bun.sleep(5);
  await a.update(one.id, (c) => ({ ...c, draft: "x" }));
  expect(a.list().map((c) => c.title)).toEqual(["one", "two"]);
});

test("branch copies the messages up to a point into a new chat", async () => {
  const a = await store();
  const m1 = say("first");
  const m2 = say("answer", "assistant");
  const m3 = say("second");
  const chat = await a.create({ title: "Root" });
  await a.update(chat.id, (c) => ({ ...c, messages: [m1, m2, m3] }));
  const branch = await a.branch(chat.id, m2.id);
  expect(branch.id).not.toBe(chat.id);
  expect(branch.messages.map((m) => m.text)).toEqual(["first", "answer"]);
  expect(branch.branchOf).toEqual({ chatId: chat.id, messageId: m2.id });
  expect(branch.tab).toBeNull();
  expect(a.get(chat.id)!.messages).toHaveLength(3);
  await expect(a.branch(chat.id, "nope")).rejects.toThrow(/no message/);
});

test("a side chat belongs to one tab, moves with it and is released when it closes", async () => {
  const a = await store();
  const one = await a.create({ tab: { id: "t1", windowId: "w1" } });
  expect(a.forTab("t1")?.id).toBe(one.id);
  // A second side chat for the same tab replaces the first, which stays in history.
  const two = await a.create({ tab: { id: "t1", windowId: "w1" } });
  expect(a.forTab("t1")?.id).toBe(two.id);
  expect(a.get(one.id)!.tab).toBeNull();
  await a.moveTab("t1", "w2");
  expect(a.forTab("t1")!.tab).toEqual({ id: "t1", windowId: "w2" });
  await a.releaseTab("t1");
  expect(a.forTab("t1")).toBeUndefined();
  expect(a.get(two.id)).toBeDefined();
});

test("drafts and scroll positions persist", async () => {
  const a = await store();
  const chat = await a.create({ tab: { id: "t9", windowId: "w1" } });
  await a.update(chat.id, (c) => ({ ...c, draft: "Reply to Maya", scrollTop: 420 }));
  const b = await store();
  expect(b.forTab("t9")).toMatchObject({ draft: "Reply to Maya", scrollTop: 420 });
});

test("remove deletes the file", async () => {
  const a = await store();
  const chat = await a.create({});
  await a.remove(chat.id);
  expect(a.get(chat.id)).toBeUndefined();
  expect(readdirSync(join(dir, "chats"))).toHaveLength(0);
});

test("a record that fails to open is skipped and reported, not fatal", async () => {
  const a = await store();
  await a.create({ title: "ok" });
  await Bun.write(join(dir, "chats", "00000000-0000-4000-8000-000000000000.chat"), "garbage");
  const b = await store();
  expect(b.list()).toHaveLength(1);
  expect(b.problems).toHaveLength(1);
});

test("concurrent updates to one chat apply in order", async () => {
  const a = await store();
  const chat = await a.create({});
  await Promise.all(Array.from({ length: 10 }, (_, i) => a.update(chat.id, (c) => ({ ...c, messages: [...c.messages, say(String(i))] }))));
  expect(a.get(chat.id)!.messages.map((m) => m.text)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  const b = await store();
  expect(b.get(chat.id)!.messages).toHaveLength(10);
});
