import { expect, test } from "bun:test";
import { hkdfSync } from "node:crypto";
import { PassThrough } from "node:stream";
import { KeySource, parseChannelLine, readKeyChannel } from "../src/secure/key-channel";

const TOKEN = "t".repeat(43);
const ROOT = Buffer.alloc(32, 7);
const APP = { op: "app", port: 50123, token: TOKEN, browserToken: "b".repeat(43), dataDir: "/Users/x/Perch", origins: [] };
const PROFILE = { op: "profile", id: "Default", dir: "/Users/x/Perch/Default", key: ROOT.toString("base64"), protected: true };

test("each store gets its own key: HKDF-SHA256 over the root key with info perch/<store>/v1", () => {
  const source = new KeySource(Buffer.from(ROOT));
  const expected = Buffer.from(hkdfSync("sha256", ROOT, Buffer.alloc(0), "perch/memory/v1", 32));
  expect(source.derive("memory").equals(expected)).toBe(true);
  expect(source.derive("memory").equals(source.derive("sync"))).toBe(false);
  expect(() => source.derive("nope" as never)).toThrow("unknown key store");
});

test("a destroyed key source zeroes its root and refuses to derive", () => {
  const root = Buffer.from(ROOT);
  const source = new KeySource(root);
  source.destroy();
  expect(root.every((b) => b === 0)).toBe(true);
  expect(() => source.derive("app")).toThrow("gone");
});

test("a key source refuses a root that is not 32 bytes", () => {
  expect(() => new KeySource(Buffer.alloc(16))).toThrow("32 bytes");
});

test("lines on fd 5 are checked: app settings, profile keys and removals", () => {
  expect(parseChannelLine(JSON.stringify(APP))).toMatchObject({ op: "app", settings: { port: 50123 } });
  const profile = parseChannelLine(JSON.stringify(PROFILE));
  expect(profile).toMatchObject({ op: "profile", id: "Default", dir: "/Users/x/Perch/Default", protected: true });
  expect(parseChannelLine(JSON.stringify({ op: "profile-removed", id: "Default" }))).toEqual({ op: "profile-removed", id: "Default" });
  expect(() => parseChannelLine(JSON.stringify({ ...PROFILE, key: Buffer.alloc(31).toString("base64") }))).toThrow("bad key");
  expect(() => parseChannelLine(JSON.stringify({ ...PROFILE, id: "../x" }))).toThrow("bad profile id");
  expect(() => parseChannelLine(JSON.stringify({ ...PROFILE, dir: "rel" }))).toThrow("bad profile folder");
  expect(() => parseChannelLine(JSON.stringify({ ...PROFILE, recovery: "%%%" }))).toThrow("bad recovery");
  expect(() => parseChannelLine(JSON.stringify({ op: "what" }))).toThrow("unknown line");
  expect(() => parseChannelLine("not json")).toThrow();
});

test("an error about a bad profile line never repeats the key", () => {
  const bad = { ...PROFILE, id: "../x" };
  try {
    parseChannelLine(JSON.stringify(bad));
  } catch (error) {
    expect((error as Error).message).not.toContain(PROFILE.key);
  }
});

test("the channel hands out settings, then a profile's keys, and drops them on removal and EOF", async () => {
  const stream = new PassThrough();
  const channel = readKeyChannel(stream);
  stream.write(`${JSON.stringify(APP)}\n`);
  expect((await channel.settings).port).toBe(50123);
  const waiting = channel.profile("Default", 1000);
  stream.write(`${JSON.stringify({ ...PROFILE, recovery: Buffer.alloc(80, 1).toString("base64") })}\n`);
  const keys = await waiting;
  expect(keys?.id).toBe("Default");
  expect(keys?.protected).toBe(true);
  expect(keys?.recovery?.length).toBe(80);
  const derived = keys!.source.derive("app");
  expect(derived.length).toBe(32);

  stream.write(`${JSON.stringify({ op: "profile-removed", id: "Default" })}\n`);
  await Bun.sleep(5);
  expect(() => keys!.source.derive("app")).toThrow("gone");
  expect(await channel.profile("Default", 10)).toBeNull();

  stream.write(`${JSON.stringify({ ...PROFILE, id: "Profile 1", dir: "/Users/x/Perch/Profile 1" })}\n`);
  const second = await channel.profile("Profile 1", 1000);
  stream.end();
  await channel.closed;
  expect(() => second!.source.derive("app")).toThrow("gone");
});

test("a profile that never arrives resolves to null after the wait", async () => {
  const stream = new PassThrough();
  const channel = readKeyChannel(stream);
  expect(await channel.profile("Default", 20)).toBeNull();
  stream.end();
});

test("EOF before the settings line rejects the settings promise", async () => {
  const stream = new PassThrough();
  const channel = readKeyChannel(stream);
  stream.end();
  await expect(channel.settings).rejects.toThrow("closed");
});

test("a bad line is reported and skipped, and later lines still work", async () => {
  const stream = new PassThrough();
  const problems: string[] = [];
  const channel = readKeyChannel(stream, { onProblem: (m) => problems.push(m) });
  stream.write("garbage\n");
  stream.write(`${JSON.stringify(APP)}\n`);
  expect((await channel.settings).port).toBe(50123);
  expect(problems.length).toBe(1);
  stream.end();
});
