import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { open, seal } from "../src/config/crypto";
import { memoryKeychain } from "../src/config/keychain";
import { defaultSettings, parseSettings, SETTINGS_FILE, SettingsStore } from "../src/config/store";
import { tempProfile } from "./helpers";

const KEY = new Uint8Array(32).fill(7);
const dirs: (() => void)[] = [];
afterEach(() => dirs.splice(0).forEach((cleanup) => cleanup()));
function tempDir(): string {
  const { dir, cleanup } = tempProfile();
  dirs.push(cleanup);
  return dir;
}

test("seal and open round-trip; the output carries no plaintext", () => {
  const plain = new TextEncoder().encode('{"secret-looking":"hello world"}');
  const sealed = seal(KEY, plain, "models.settings");
  expect(new TextDecoder().decode(open(KEY, sealed, "models.settings"))).toBe('{"secret-looking":"hello world"}');
  expect(Buffer.from(sealed).toString("latin1")).not.toContain("hello world");
  // A fresh IV each time.
  expect(Buffer.from(seal(KEY, plain, "models.settings")).equals(Buffer.from(sealed))).toBe(false);
});

test("open fails on a wrong key, wrong context, tampering or a bad header", () => {
  const sealed = seal(KEY, new TextEncoder().encode("data"), "a");
  expect(() => open(new Uint8Array(32).fill(8), sealed, "a")).toThrow();
  expect(() => open(KEY, sealed, "b")).toThrow();
  const tampered = new Uint8Array(sealed);
  tampered[tampered.length - 1]! ^= 1;
  expect(() => open(KEY, tampered, "a")).toThrow();
  expect(() => open(KEY, new Uint8Array([1, 2, 3]), "a")).toThrow();
  expect(() => seal(new Uint8Array(16), new Uint8Array(1), "a")).toThrow();
});

test("the memory keychain stores, replaces and deletes; names are validated", async () => {
  const kc = memoryKeychain();
  expect(await kc.get("api-key:openai")).toBeNull();
  await kc.set("api-key:openai", "sk-one");
  await kc.set("api-key:openai", "sk-two");
  expect(await kc.get("api-key:openai")).toBe("sk-two");
  expect(await kc.delete("api-key:openai")).toBe(true);
  expect(await kc.delete("api-key:openai")).toBe(false);
  await expect(kc.set("../bad name", "x")).rejects.toThrow("Keychain item name");
  await expect(kc.set("ok", "")).rejects.toThrow("empty");
});

test("the store starts with defaults, saves encrypted with mode 0600, and reads back", async () => {
  const dir = tempDir();
  const keychain = memoryKeychain();
  const store = await SettingsStore.open({ dir, keychain });
  expect(store.get()).toEqual(defaultSettings());
  const next = await store.update((s) => ({ ...s, providers: { ...s.providers, openai: { connected: true } }, lastUsed: { provider: "openai", model: "gpt-6-astra" } }));
  expect(next.providers.openai).toEqual({ connected: true });
  const file = join(dir, SETTINGS_FILE);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file).toString("latin1")).not.toContain("gpt-6-astra");
  expect(await keychain.get("settings-key")).toBeTruthy();
  const again = await SettingsStore.open({ dir, keychain });
  expect(again.get().lastUsed).toEqual({ provider: "openai", model: "gpt-6-astra" });
  expect(again.recovered).toBe(false);
});

test("settings returned by the store are frozen", async () => {
  const store = await SettingsStore.open({ dir: tempDir(), keychain: memoryKeychain() });
  expect(Object.isFrozen(store.get())).toBe(true);
  expect(Object.isFrozen(store.get().providers)).toBe(true);
});

test("an unreadable settings file is set aside and Perch starts fresh", async () => {
  const dir = tempDir();
  const keychain = memoryKeychain();
  writeFileSync(join(dir, SETTINGS_FILE), "garbage");
  const store = await SettingsStore.open({ dir, keychain });
  expect(store.recovered).toBe(true);
  expect(store.get()).toEqual(defaultSettings());
  expect(readdirSync(dir).some((f) => f.startsWith(`${SETTINGS_FILE}.unreadable-`))).toBe(true);
});

test("a settings file whose key is gone is set aside", async () => {
  const dir = tempDir();
  const keychain = memoryKeychain();
  const store = await SettingsStore.open({ dir, keychain });
  await store.update((s) => ({ ...s, lastUsed: { provider: "grok", model: "grok-4.7" } }));
  await keychain.delete("settings-key");
  const again = await SettingsStore.open({ dir, keychain });
  expect(again.recovered).toBe(true);
  expect(again.get().lastUsed).toBeUndefined();
  expect(existsSync(join(dir, SETTINGS_FILE))).toBe(false);
});

test("update rejects a result that fails validation and keeps the old settings", async () => {
  const store = await SettingsStore.open({ dir: tempDir(), keychain: memoryKeychain() });
  await expect(store.update((s) => ({ ...s, roles: { deep: { provider: "nope", model: "x" } } }) as never)).rejects.toThrow("provider");
  expect(store.get()).toEqual(defaultSettings());
});

test("parseSettings validates every field", () => {
  expect(parseSettings(defaultSettings())).toEqual(defaultSettings());
  expect(() => parseSettings({ version: 2 })).toThrow("version");
  expect(() => parseSettings({ ...defaultSettings(), providers: { openai: { connected: "yes" } } })).toThrow("connected");
  expect(() => parseSettings({ ...defaultSettings(), providers: { ollama: { connected: true, baseUrl: "file:///etc" } } })).toThrow("base URL");
  expect(() => parseSettings({ ...defaultSettings(), roles: { visual: { provider: "openai", model: "" } } })).toThrow("model");
  expect(() => parseSettings({ ...defaultSettings(), roles: { sideways: { provider: "openai", model: "x" } } })).toThrow("role");
  expect(() => parseSettings({ ...defaultSettings(), roles: { deep: { provider: "openai", model: "x", effort: "huge" } } })).toThrow("effort");
  const ok = parseSettings({ ...defaultSettings(), roles: { deep: { provider: "anthropic", model: "claude-opus-5-5", effort: "high", fast: true } } });
  expect(ok.roles.deep).toEqual({ provider: "anthropic", model: "claude-opus-5-5", effort: "high", fast: true });
});
