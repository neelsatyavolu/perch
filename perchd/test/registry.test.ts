import { afterEach, expect, test } from "bun:test";
import { bundledModels } from "@neelsatyavolu/shared-ai-auth";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { memoryKeychain } from "../src/config/keychain";
import { SETTINGS_FILE, SettingsStore } from "../src/config/store";
import type { ProviderId } from "../src/models/ids";
import { createModelRegistry, type RegistryOptions } from "../src/models/registry";
import type { Model, TurnEvent } from "../src/models/types";
import { fakeServer, json, PNG_1PX, sse, type FakeServer } from "./fixtures/fake-providers";
import { tempProfile } from "./helpers";

const ANTHROPIC_KEY = "sk-ant-test-0123456789abcdef";
const OPENAI_KEY = "sk-proj-test-0123456789abcdef";

let server: FakeServer | null = null;
const cleanups: (() => void)[] = [];
afterEach(() => {
  server?.stop();
  cleanups.splice(0).forEach((c) => c());
});

function temp(): string {
  const { dir, cleanup } = tempProfile();
  cleanups.push(cleanup);
  return dir;
}

/** One fake standing in for every provider, under a path prefix per provider. */
function providers(): FakeServer {
  return fakeServer((req) => {
    const auth = req.headers.authorization ?? req.headers["x-api-key"] ?? "";
    if (auth.includes("revoked")) return json({ error: { message: "invalid key" } }, 401);
    switch (`${req.method} ${req.path}`) {
      case "GET /anthropic/v1/models":
        return json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }] });
      case "POST /anthropic/v1/messages":
        return sse([{ type: "message_start", message: { usage: { input_tokens: 5 } } }, { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi from claude" } }, { type: "message_stop" }]);
      case "GET /openai/v1/models":
        return json({ data: [{ id: "gpt-6-astra" }, { id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }, { id: "gpt-image-2.5-sunburst" }, { id: "whisper-1" }] });
      case "POST /openai/v1/images/generations":
        return json({ data: [{ b64_json: PNG_1PX }] });
      case "GET /ollama/v1/models":
        return json({ data: [{ id: "qwen3:8b" }, { id: "llava:13b" }] });
      case "POST /ollama/v1/chat/completions":
        return sse([{ choices: [{ delta: { content: "hi from ollama" }, finish_reason: "stop" }] }]);
      case "GET /grok/v1/models":
        return auth === "Bearer grok-access-0123456789" ? json({ data: [{ id: "grok-4.7" }] }) : json({ error: { message: "bad token" } }, 401);
      case "POST /oauth2/token":
        return json({ access_token: "grok-access-0123456789", refresh_token: "grok-refresh-0123456789", expires_in: 3600 });
      case "POST /oauth/token":
        return json({ access_token: "chatgpt-access-0123456789", refresh_token: "chatgpt-refresh-0123456789", expires_in: 3600 });
      case "POST /codex/responses":
        return sse([{ type: "response.output_text.delta", delta: "OK" }, { type: "response.completed", response: {} }]);
      default:
        return json({ error: { message: `no route ${req.method} ${req.path}` } }, 404);
    }
  });
}

async function setup(extra: Partial<RegistryOptions> = {}) {
  server = providers();
  const fake = server;
  const dir = temp();
  const keychain = memoryKeychain();
  const store = await SettingsStore.open({ dir, keychain });
  const urls: Partial<Record<ProviderId, string>> = {
    anthropic: `${fake.url}/anthropic/v1`,
    openai: `${fake.url}/openai/v1`,
    codex: `${fake.url}/codex`,
    grok: `${fake.url}/grok/v1`,
  };
  // Token requests go to the real auth hosts' paths on the fake server.
  const routed = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const authHost = u.hostname === "auth.openai.com" || u.hostname === "auth.x.ai";
    return fetch(authHost ? `${fake.url}${u.pathname}` : String(url), init);
  }) as typeof fetch;
  const registry = createModelRegistry({
    store,
    keychain,
    fetch: routed,
    urls,
    catalog: async () => bundledModels,
    claudeCode: async () => ({ installed: false }),
    loopback: null,
    ...extra,
  });
  cleanups.push(registry.dispose);
  return { registry, keychain, store, dir, fake };
}

async function text(model: Model): Promise<string> {
  let out = "";
  for await (const e of model.turn({ system: "s", messages: [{ role: "user", text: "hi" }], tools: [] }, new AbortController().signal) as AsyncIterable<TurnEvent>) {
    if (e.type === "text") out += e.delta;
  }
  return out;
}

test("nothing is connected at first, and each provider says what it needs", async () => {
  const { registry } = await setup();
  const list = await registry.listProviders();
  expect(list.map((p) => p.id)).toEqual(["codex", "claude-code", "grok", "anthropic", "openai", "xai", "gemini", "openrouter", "custom", "lmstudio", "ollama"]);
  expect(list.every((p) => !p.connected)).toBe(true);
  expect(list.find((p) => p.id === "codex")).toMatchObject({ kind: "subscription", state: "signed-out", connect: "sign-in" });
  expect(list.find((p) => p.id === "claude-code")).toMatchObject({ state: "not-installed", connect: "install" });
  expect(list.find((p) => p.id === "anthropic")).toMatchObject({ kind: "api", state: "not-set-up", connect: "key" });
  expect(list.find((p) => p.id === "ollama")).toMatchObject({ kind: "local", connect: "endpoint", baseUrl: "http://127.0.0.1:11434/v1" });
  expect(await registry.getRoles()).toMatchObject({ default: null, image: null });
});

test("a key is checked before it is saved, kept only in the Keychain, and its models are listed", async () => {
  const { registry, keychain, dir } = await setup();
  const result = await registry.setKey("anthropic", `  ${ANTHROPIC_KEY}\n`);
  expect(result).toMatchObject({ ok: true });
  expect(result.message).toBe("Connected. 3 models.");
  expect(await keychain.get("api-key:anthropic")).toBe(ANTHROPIC_KEY);
  expect((await registry.listProviders()).find((p) => p.id === "anthropic")).toMatchObject({ connected: true, state: "connected" });
  const models = await registry.listModels("anthropic");
  expect(models.map((m) => m.id)).toEqual(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  expect(models[0]).toMatchObject({ vision: true, tools: true, context: 1_000_000 });
  const roles = await registry.getRoles();
  expect(roles.deep).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
  expect(roles.fast?.model).toBe("claude-haiku-5-5");
  expect(roles.image).toBeNull();
  const handle = await registry.modelFor("deep");
  expect(handle.kind).toBe("model");
  if (handle.kind === "model") expect(await text(handle.model)).toBe("hi from claude");
  expect(readFileSync(join(dir, SETTINGS_FILE)).toString("latin1")).not.toContain(ANTHROPIC_KEY);
  expect(server!.seen.find((s) => s.path === "/anthropic/v1/models")!.headers["x-api-key"]).toBe(ANTHROPIC_KEY);
});

test("a rejected key is not saved and the message does not repeat it", async () => {
  const { registry, keychain } = await setup();
  const error = await registry.setKey("anthropic", "sk-ant-revoked-0123456789").catch((e: Error) => e);
  expect(String(error)).toContain("Anthropic rejected that key");
  expect(String(error)).not.toContain("sk-ant-revoked");
  expect(await keychain.get("api-key:anthropic")).toBeNull();
  expect((await registry.listProviders()).find((p) => p.id === "anthropic")!.connected).toBe(false);
});

test("a key for a provider that is not a key provider is refused", async () => {
  const { registry } = await setup();
  await expect(registry.setKey("codex", OPENAI_KEY)).rejects.toThrow("signs in");
  await expect(registry.setKey("bogus" as ProviderId, OPENAI_KEY)).rejects.toThrow("Unknown provider");
});

test("a local endpoint connects without a key and fills the roles it can", async () => {
  const { registry } = await setup();
  const result = await registry.connectEndpoint("ollama", { baseUrl: `${server!.url}/ollama/v1` });
  expect(result.ok).toBe(true);
  const roles = await registry.getRoles();
  expect(roles.default).toMatchObject({ provider: "ollama", model: "qwen3:8b" });
  expect(roles.visual).toMatchObject({ provider: "ollama", model: "llava:13b" });
  const handle = await registry.modelFor("default");
  if (handle.kind !== "model") throw new Error("expected a model");
  expect(await text(handle.model)).toBe("hi from ollama");
  expect(server!.seen.find((s) => s.path === "/ollama/v1/chat/completions")!.headers.authorization).toBeUndefined();
});

test("an endpoint that is not running is reported, not saved", async () => {
  const { registry } = await setup();
  const error = await registry.connectEndpoint("lmstudio", { baseUrl: "http://127.0.0.1:9/v1" }).catch((e: Error) => e);
  expect(String(error)).toContain("Could not reach LM Studio");
  expect((await registry.listProviders()).find((p) => p.id === "lmstudio")!.connected).toBe(false);
  await expect(registry.connectEndpoint("custom", { baseUrl: "http://example.com/v1" })).rejects.toThrow("https");
});

test("setRole validates; the last model used becomes Default; sign-out falls back", async () => {
  const { registry } = await setup();
  await registry.setKey("anthropic", ANTHROPIC_KEY);
  await registry.setKey("openai", OPENAI_KEY);
  let roles = await registry.setRole("deep", { provider: "openai", model: "gpt-6-astra", effort: "max" });
  expect(roles.deep).toMatchObject({ provider: "openai", model: "gpt-6-astra", effort: "max", source: "chosen" });
  await expect(registry.setRole("visual", { provider: "openai", model: "gpt-image-2.5-sunburst" })).rejects.toThrow("cannot use");
  await expect(registry.setRole("deep", { provider: "openai", model: "gpt-9" })).rejects.toThrow("does not offer gpt-9");
  await expect(registry.setRole("sideways" as never, { provider: "openai", model: "gpt-6-astra" })).rejects.toThrow("Unknown role");

  roles = await registry.noteUsed({ provider: "anthropic", model: "claude-sonnet-5-5" });
  expect(roles.default).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5-5", source: "chosen" });

  const deep = await registry.modelFor("deep");
  expect(deep.kind === "model" && deep.effort).toBe("xhigh");

  await registry.signOut("openai");
  roles = await registry.getRoles();
  expect(roles.deep).toMatchObject({ provider: "anthropic", source: "fallback" });
  expect(roles.deep?.note).toContain("OpenAI is not connected");
  // The choice is kept, as Aside does: reconnecting brings it back.
  await registry.setKey("openai", OPENAI_KEY);
  expect((await registry.getRoles()).deep).toMatchObject({ provider: "openai", source: "chosen" });
  roles = await registry.setRole("deep", null);
  expect(roles.deep?.source).toBe("default");
});

test("ChatGPT sign-in through the registry: catalog models, tokens used for turns, connection test", async () => {
  const { registry, keychain, fake } = await setup();
  const { url, needsPaste } = await registry.startSignIn("codex");
  expect(needsPaste).toBe(true); // the loopback is off in tests
  const state = new URL(url).searchParams.get("state");
  await registry.finishSignIn("codex", `http://localhost:1455/auth/callback?code=c0de&state=${state}`);
  expect((await registry.listProviders()).find((p) => p.id === "codex")).toMatchObject({ connected: true, state: "connected" });
  expect((await registry.listModels("codex")).map((m) => m.id)).toEqual([...bundledModels.codex.map((m) => m.id), "gpt-image-2.5-sunburst"]);
  const roles = await registry.getRoles();
  expect(roles.default).toMatchObject({ provider: "codex", model: "gpt-6-astra" });
  expect(roles.image).toMatchObject({ provider: "codex", model: "gpt-image-2.5-sunburst" });
  const check = await registry.testConnection("codex");
  expect(check.ok).toBe(true);
  const turn = fake.seen.find((s) => s.path === "/codex/responses")!;
  expect(turn.headers.authorization).toBe("Bearer chatgpt-access-0123456789");
  await registry.signOut("codex");
  expect(await keychain.get("oauth:codex")).toBeNull();
  await expect(registry.startSignIn("anthropic" as never)).rejects.toThrow("API key");
});

test("Claude Code connects when installed and runs as a whole-task runner", async () => {
  const { registry } = await setup({ claudeCode: async () => ({ installed: true, version: "3.1.0" }) });
  const result = await registry.connectClaudeCode();
  expect(result).toMatchObject({ ok: true, message: "Connected to Claude Code 3.1.0." });
  const roles = await registry.getRoles();
  expect(roles.default).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
  expect(roles.visual).toBeNull();
  expect(await registry.modelFor("deep")).toMatchObject({ kind: "runner", runner: "claude-code", model: "claude-opus-5-5" });
});

test("Claude Code that is not installed cannot be connected", async () => {
  const { registry } = await setup();
  await expect(registry.connectClaudeCode()).rejects.toThrow("Install Claude Code");
});

test("image generation uses the Image role and saves into the chat folder", async () => {
  const { registry } = await setup();
  await registry.setKey("openai", OPENAI_KEY);
  const folder = temp();
  const files = await registry.generateImage({ prompt: "A lighthouse", folder });
  expect(files).toHaveLength(1);
  expect(readdirSync(folder)).toHaveLength(1);
  const req = server!.seen.find((s) => s.path === "/openai/v1/images/generations")!;
  expect(req.body.model).toBe("gpt-image-2.5-sunburst");
});

test("with no image provider, image generation says what to connect", async () => {
  const { registry } = await setup();
  await registry.setKey("anthropic", ANTHROPIC_KEY);
  await expect(registry.generateImage({ prompt: "x", folder: temp() })).rejects.toThrow("Connect ChatGPT, OpenAI, Grok, xAI or Google Gemini");
});

test("modelFor a role with nothing connected explains what to do", async () => {
  const { registry } = await setup();
  await expect(registry.modelFor("default")).rejects.toThrow("Connect a model provider");
});

test("Grok's connection test asks xAI with the sign-in, and fails once the token is refused", async () => {
  const { registry, keychain } = await setup();
  await registry.startSignIn("grok");
  await registry.finishSignIn("grok", "bare-code");
  expect(await registry.testConnection("grok")).toMatchObject({ ok: true });
  expect(server!.seen.find((s) => s.path === "/grok/v1/models")!.headers.authorization).toBe("Bearer grok-access-0123456789");
  const stored = JSON.parse((await keychain.get("oauth:grok"))!);
  await keychain.set("oauth:grok", JSON.stringify({ ...stored, accessToken: "stale-token-0123456789" }));
  expect(await registry.testConnection("grok")).toMatchObject({ ok: false, code: "auth", message: "Sign in to Grok again in Settings → Models." });
});

test("a key revoked after connecting stops serving roles; another provider takes over", async () => {
  let clock = Date.now();
  const { registry, keychain } = await setup({ now: () => clock });
  await registry.setKey("anthropic", ANTHROPIC_KEY);
  await registry.setKey("openai", OPENAI_KEY);
  await registry.setRole("deep", { provider: "openai", model: "gpt-6-astra" });
  await keychain.set("api-key:openai", "sk-revoked-0123456789abcdef");
  clock += 11 * 60_000; // past the model list cache
  const roles = await registry.getRoles();
  expect(roles.deep).toMatchObject({ provider: "anthropic", source: "fallback" });
});

test("a model from the picker must be offered and able to use tools", async () => {
  const { registry } = await setup();
  await registry.setKey("openai", OPENAI_KEY);
  await expect(registry.modelFor({ provider: "openai", model: "gpt-image-2.5-sunburst" })).rejects.toThrow("cannot use Perch's tools");
  await expect(registry.modelFor({ provider: "anthropic", model: "claude-opus-5-5" })).rejects.toThrow("Connect Anthropic first");
  const handle = await registry.modelFor({ provider: "openai", model: "gpt-6-luna", effort: "low" });
  expect(handle).toMatchObject({ kind: "model", provider: "openai", effort: "low" });
});
