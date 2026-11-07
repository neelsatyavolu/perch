/**
 * The pages API end to end: ui-pages' own RPC adapter (createRpcApi) over a bridge that speaks
 * HTTP and the app WebSocket to a real app server, backed by the real modules on temp folders.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { bundledModels } from "@neelsatyavolu/shared-ai-auth";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { API_METHODS, type JobProgress, type PerchApi } from "../../ui-pages/src/api";
import { createRpcApi, type Bridge } from "../../ui-pages/src/api/rpc";
import { AuditLog } from "../src/agent/audit";
import { startApp, type App } from "../src/app/app";
import { memoryKeychain as appKeychain } from "../src/app/keychain";
import { BROWSER_METHODS, createPagesApi, PERCHD_METHODS } from "../src/app/pages-api";
import { Jobs } from "../src/app/pages/jobs";
import { PagesState } from "../src/app/pages/state";
import { Vault } from "../src/app/vault";
import { memoryKeychain as settingsKeychain } from "../src/config/keychain";
import { SettingsStore } from "../src/config/store";
import { ClientRegistry } from "../src/daemon/clients";
import { MemoryKeychain as ClientKeychain } from "../src/daemon/keychain";
import { memoryKeychain as importKeychain } from "../src/import/keychain";
import { findImports } from "../src/mcp-client/importers/sources";
import { McpManager } from "../src/mcp-client/manager";
import { RegistryStore } from "../src/mcp-client/registry";
import { mockKeychain } from "../src/memory/keychain";
import { createModelRegistry } from "../src/models/registry";
import { fakeModel } from "../src/models/fake";
import { openPerchData, type PerchData } from "../src/routines/service";
import { MemoryKeychain } from "../src/secure/keychain";
import { SkillCatalog } from "../src/skills/catalog";
import { SkillStore } from "../src/skills/store";
import { fakeServer, json, type FakeServer } from "./fixtures/fake-providers";
import { chromeProfile, FAKE_SAFE_STORAGE, HISTORY_SCHEMA, sqlite } from "./import/fixtures";

const TOKEN = "page-token-0123456789abcdef0123456789abcdef";
const BROWSER_TOKEN = "browser-token-0123456789abcdef0123456789ab";
const ANTHROPIC_KEY = "sk-ant-test-0123456789abcdef";
const GITHUB_SECRET = "ghp_envsecret0123456789abcdef";
const ARG_SECRET = "ghp_argsecret0123456789abcdef";
const TYPED_KEY = "sk-live-typed0123456789abcdef";
const ENV_VALUE = "env-value-that-is-secret-42";

let dir: string;
let app: App;
let api: PerchApi;
let providers: FakeServer;
let data: PerchData;
let secrets: MemoryKeychain;
let skills: SkillStore;
let builtIn: string;
const opened: string[] = [];
const events: { event: string; data: unknown }[] = [];
let ws: WebSocket;

type Failure = Error & { status?: number };

function bridge(url: string, token: string, socket: WebSocket): Bridge {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  socket.addEventListener("message", (m) => {
    const e = JSON.parse(String(m.data)) as { type: string; event?: string; data?: unknown };
    if (e.type !== "pages.event" || !e.event) return;
    events.push({ event: e.event, data: e.data });
    for (const l of listeners.get(e.event) ?? []) l(e.data);
  });
  return {
    async call(method, args) {
      const res = await fetch(`${url}/api/pages/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
      const body = (await res.json()) as { error?: string };
      if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status });
      return body;
    },
    subscribe(event, listener) {
      const set = listeners.get(event) ?? new Set();
      listeners.set(event, set.add(listener));
      return () => set.delete(listener);
    },
  };
}

async function raw(method: string, args: unknown, token = TOKEN): Promise<{ status: number; body: { error?: string } }> {
  const res = await fetch(`${app.server.url}/api/pages/${method}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  return { status: res.status, body: (await res.json()) as { error?: string } };
}

async function fails(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise;
  } catch (error) {
    return error as Failure;
  }
  throw new Error("expected the call to fail");
}

function untilDone(id: string): Promise<JobProgress[]> {
  const seen: JobProgress[] = [];
  return new Promise((resolve) => {
    const stop = api.watchJob(id, (p) => {
      seen.push(p);
      if (p.state !== "running") {
        stop();
        resolve(seen);
      }
    });
  });
}

async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (ok(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error("timed out");
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "perch-pages-"));
  const home = join(dir, "home");
  chromeProfile(home);
  write(
    join(home, ".claude.json"),
    JSON.stringify({ mcpServers: { github: { command: "npx", args: ["-y", "server-github", "--token", ARG_SECRET], env: { GITHUB_TOKEN: GITHUB_SECRET } } } }),
  );
  builtIn = join(dir, "built-in");
  write(join(builtIn, "maps", "SKILL.md"), "---\nname: maps\ndescription: Find places on a map.\n---\nUse the map.\n");
  write(join(dir, "my-skill", "SKILL.md"), "---\nname: invoices\ndescription: File invoices.\n---\nFile them.\n");
  const userData = join(dir, "user-data");
  sqlite(join(userData, "Default", "History"), HISTORY_SCHEMA).close();
  const audit = join(dir, "audit.jsonl");
  writeFileSync(
    audit,
    [
      { time: "2026-11-01T10:00:00.000Z", tab: "Mail", site: "mail.example", action: "click", detail: 'button "Send"', client: "perch-sidebar", approved: true, result: "ok" },
      { time: "2026-11-02T10:00:00.000Z", tab: "Shop", site: "shop.example", action: "type", client: "claude-code", approved: false, result: "declined" },
    ].map((e) => JSON.stringify(e)).join("\n") + "\n",
  );

  providers = fakeServer((req) => (req.path === "/anthropic/v1/models" ? json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-sonnet-5-5" }] }) : json({}, 404)));
  const modelKeychain = settingsKeychain();
  const registry = createModelRegistry({
    store: await SettingsStore.open({ dir: join(dir, "models"), keychain: modelKeychain }),
    keychain: modelKeychain,
    urls: { anthropic: `${providers.url}/anthropic/v1` },
    catalog: async () => bundledModels,
    claudeCode: async () => ({ installed: true, version: "2.4" }),
    loopback: null,
  });
  const propose = fakeModel(() => [
    { type: "tool_call", call: { id: "p", name: "propose_profile", args: { items: [{ group: "about", title: "You", text: "Reads docs every morning" }, { group: "people", title: "Maya", text: "Maya is a coworker" }] } } },
    { type: "done" },
  ]);
  data = await openPerchData({
    dataDir: join(dir, "data"),
    profile: "default",
    keys: mockKeychain(),
    models: { fast: async () => propose, forRoutine: async () => Promise.reject(new Error("No model in this test")) },
    browser: async () => Promise.reject(new Error("No browser in this test")),
    audit: new AuditLog(join(dir, "routines-audit.jsonl")),
    setupInputs: () => ({ tabs: async () => [{ id: "t1", title: "Docs", url: "https://docs.example.com/" }] }),
  });
  secrets = new MemoryKeychain();
  const mcpStore = new RegistryStore(join(dir, "mcp-servers.enc"), secrets);
  const manager = new McpManager({ store: mcpStore, keychain: secrets, approveLaunch: async () => false, openUrl: async () => undefined, connectTimeoutMs: 2000 });
  skills = new SkillStore(join(dir, "skills"), secrets);
  const clients = new ClientRegistry(join(dir, "clients.json"), new ClientKeychain());
  await clients.verify("claude-code", await clients.token("claude-code"));
  const vault = await Vault.open(appKeychain(), "Default");

  app = await startApp({
    dataDir: join(dir, "app"),
    vault,
    runner: async function* () {
      yield { type: "final", text: "Done." };
    },
    models: [{ id: "fake", label: "Fake", provider: "test", efforts: ["medium"] }],
    allowedOrigins: ["chrome://perch-settings"],
    token: TOKEN,
    browserToken: BROWSER_TOKEN,
    pages: (core) =>
      createPagesApi({
        chats: core.chats,
        runs: core.runs,
        setDefaults: core.setDefaults,
        jobs: new Jobs(core.emit),
        state: new PagesState(join(dir, "pages"), vault),
        models: { registry: async () => registry, keychain: modelKeychain, openUrl: async (url) => void opened.push(url), signInTimeoutMs: 50 },
        mcp: { store: mcpStore, keychain: secrets, manager, findImports: () => findImports({ home, env: {} }) },
        skills: { store: skills, builtInDir: builtIn, home },
        clients,
        audit: new AuditLog(audit, { legacy: [join(dir, "missing.jsonl")] }),
        data: async () => data,
        importer: { home, target: { userDataDir: userData }, keychain: importKeychain({ "Chrome Safe Storage": FAKE_SAFE_STORAGE }) },
      }),
  });
  ws = new WebSocket(`${app.server.url.replace("http", "ws")}/ws`, ["perch-app", `token.${TOKEN}`]);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  api = createRpcApi(bridge(app.server.url, TOKEN, ws));
});

afterAll(async () => {
  ws.close();
  await app.stop();
  data.stop();
  providers.stop();
  rmSync(dir, { recursive: true, force: true });
});

test("the route: page token only, a fixed list of methods, browser-owned ones not here", async () => {
  expect((await raw("listChats", [5], BROWSER_TOKEN)).status).toBe(403);
  expect((await raw("listChats", [5], "wrong")).status).toBe(401);
  expect(await raw("noSuchMethod", [])).toEqual({ status: 404, body: { error: "not found" } });
  expect((await raw("watchJob", [])).status).toBe(404);
  for (const m of BROWSER_METHODS) expect((await raw(m, [])).status).toBe(404);
  expect((await raw("listChats", { limit: 5 })).body.error).toBe("The arguments must be a JSON array");
  expect((await raw("listChats", [1, 2])).body.error).toBe("This method takes at most 1 argument");
  expect((await raw("listProviders", [1])).body.error).toBe("This method takes no arguments");
  expect([...PERCHD_METHODS, ...BROWSER_METHODS].sort()).toEqual([...API_METHODS].sort());
});

test("new tab page: layout, chats, suggestions; navigation is not perchd's yet", async () => {
  expect(await api.getNtpLayout()).toEqual({ railOpen: true, hidden: [], recentTab: "chats" });
  expect(await api.setNtpLayout({ railOpen: false, hidden: ["suggested"] })).toEqual({ railOpen: false, hidden: ["suggested"], recentTab: "chats" });
  expect((await fails(api.setNtpLayout({ hidden: ["sidebar" as never] }))).status).toBe(400);

  const chat = await app.chats.create({ title: "Flights to Lisbon", settings: app.info().defaults });
  await app.chats.update(chat.id, (c) => ({ ...c, messages: [{ id: "m1", role: "user", text: "Find a cheap flight", time: c.createdAt }] }));
  await Bun.sleep(5);
  await app.chats.create({ title: "Groceries", settings: app.info().defaults });
  expect((await api.listChats(1)).map((c) => c.title)).toEqual(["Groceries"]);
  expect((await api.listChats(10)).map((c) => c.status)).toEqual(["idle", "idle"]);
  expect((await fails(api.listChats(-1))).status).toBe(400);
  expect((await api.searchChats("cheap FLIGHT")).map((c) => c.title)).toEqual(["Flights to Lisbon"]);
  expect((await fails(api.searchChats(42 as never))).status).toBe(400);

  expect((await api.listSuggestions()).map((s) => s.id)).toEqual(["setup-import", "setup-memory", "setup-routines"]);
  await api.dismissSuggestion("setup-memory");
  expect((await api.listSuggestions()).map((s) => s.id)).toEqual(["setup-import", "setup-routines"]);
  expect((await fails(api.dismissSuggestion("not an id!"))).status).toBe(400);

  // The browser opens chats and runs searches; perchd doesn't know these.
  for (const m of ["submitQuery", "openChat", "newChat"]) expect((await raw(m, [])).status).toBe(404);
});

test("onboarding", async () => {
  expect(await api.getOnboarding()).toEqual({ finished: false, done: [] });
  expect(await api.completeOnboardingStep("models")).toEqual({ finished: false, done: ["models"] });
  expect(await api.completeOnboardingStep("models")).toEqual({ finished: false, done: ["models"] });
  expect((await fails(api.completeOnboardingStep("nope" as never))).status).toBe(400);
  expect(await api.finishOnboarding()).toEqual({ finished: true, done: ["models"] });
  expect((await raw("getOnboarding", [1])).status).toBe(400);
  expect((await raw("finishOnboarding", [1])).status).toBe(400);
});

test("models: keys go in and only a hint comes out; roles and models", async () => {
  const before = await api.listProviders();
  expect(before.map((p) => p.id)).toEqual(["claude-code", "chatgpt", "grok", "anthropic", "openai", "xai", "gemini", "openrouter", "local"]);
  expect(before.find((p) => p.id === "anthropic")).toMatchObject({ kind: "api-key", state: "signed-out" });

  expect((await fails(api.connectProvider({ kind: "api-key", provider: "anthropic", key: "short" }))).status).toBe(400);
  expect((await fails(api.connectProvider({ kind: "api-key", provider: "chatgpt" as never, key: ANTHROPIC_KEY }))).status).toBe(400);
  const connected = await api.connectProvider({ kind: "api-key", provider: "anthropic", key: ANTHROPIC_KEY });
  expect(connected).toMatchObject({ id: "anthropic", state: "connected", account: "Key ending cdef" });
  const listed = JSON.stringify(await api.listProviders());
  expect(listed).not.toContain(ANTHROPIC_KEY);
  expect(listed).toContain("Key ending cdef");

  expect(await api.signIn("claude-code")).toMatchObject({ id: "claude-code", state: "connected" });
  expect((await fails(api.signIn("anthropic"))).message).toBe("Anthropic connects with a key or an endpoint");
  expect((await fails(api.signIn("chatgpt"))).status).toBe(408);
  expect(opened[0]).toStartWith("https://");

  const models = await api.listModels();
  expect(models).toContainEqual({ id: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5", provider: "anthropic", vision: expect.any(Boolean), imageGeneration: false });
  expect((await raw("listModels", [1])).status).toBe(400);

  expect(await api.setTaskModel("deep", { modelId: "anthropic:claude-opus-5-5", effort: "high" })).toEqual({ role: "deep", modelId: "anthropic:claude-opus-5-5", effort: "high", fast: false });
  expect(await api.setTaskModel("deep", { fast: true })).toMatchObject({ modelId: "anthropic:claude-opus-5-5", effort: "high", fast: true });
  expect((await api.getTaskModels()).find((t) => t.role === "deep")).toMatchObject({ effort: "high", fast: true });
  expect((await fails(api.setTaskModel("deep", { modelId: "nobody:nothing" }))).status).toBe(400);
  expect((await fails(api.setTaskModel("boss" as never, {}))).status).toBe(400);
  expect((await raw("getTaskModels", [1])).status).toBe(400);

  expect(await api.signOut("anthropic")).toMatchObject({ id: "anthropic", state: "signed-out" });
  expect((await fails(api.signOut("aol" as never))).status).toBe(400);
  expect((await raw("listProviders", ["x"])).status).toBe(400);
});

test("MCP: imports and new servers keep secrets in the Keychain and return names only", async () => {
  const found = await api.scanMcpImports();
  expect(found).toHaveLength(1);
  expect(found[0]).toMatchObject({ name: "github", source: "claude-code", transport: "stdio", alreadyAdded: false });
  expect(found[0]!.secretNames).toEqual(expect.arrayContaining(["TOKEN", "GITHUB_TOKEN"]));
  expect(found[0]!.target).toBe("npx -y server-github --token ${TOKEN}");
  expect(JSON.stringify(found)).not.toContain(ARG_SECRET);
  expect(JSON.stringify(found)).not.toContain(GITHUB_SECRET);
  expect((await raw("scanMcpImports", [1])).status).toBe(400);

  const imported = await api.importMcpServers([found[0]!.key]);
  expect(imported).toMatchObject([{ id: "github", source: "claude-code", enabled: true, trusted: false }]);
  expect(JSON.stringify(imported)).not.toContain(GITHUB_SECRET);
  expect(await api.importMcpServers([found[0]!.key])).toEqual([]);
  expect((await api.scanMcpImports())[0]!.alreadyAdded).toBe(true);
  expect((await fails(api.importMcpServers("all" as never))).status).toBe(400);

  const added = await api.addMcpServer({
    name: "Docs search",
    transport: "stdio",
    target: `docs-mcp --api-key ${TYPED_KEY} --verbose`,
    secrets: [{ name: "DOCS_TOKEN", value: ENV_VALUE }],
  });
  expect(added).toMatchObject({ id: "Docs-search", name: "Docs-search", source: "manual", target: "docs-mcp --api-key ${API_KEY} --verbose" });
  expect(added.secretNames).toEqual(expect.arrayContaining(["API_KEY", "DOCS_TOKEN"]));
  const listed = JSON.stringify(await api.listMcpServers());
  for (const secret of [TYPED_KEY, ENV_VALUE, GITHUB_SECRET, ARG_SECRET]) expect(listed).not.toContain(secret);
  expect(await secrets.get("mcp/Docs-search/arg/1")).toBe(TYPED_KEY);
  expect(await secrets.get("mcp/Docs-search/env/DOCS_TOKEN")).toBe(ENV_VALUE);
  expect((await fails(api.addMcpServer({ name: "x", transport: "ftp" as never, target: "x", secrets: [] }))).status).toBe(400);
  expect((await fails(api.addMcpServer({ name: "web", transport: "http", target: "http://example.com/mcp", secrets: [] }))).message).toBe("Use https for a server that isn't on this Mac");
  const remote = await api.addMcpServer({ name: "web", transport: "http", target: "https://mcp.example.com/sse?api_key=sk-live-inurl0123456789", secrets: [{ name: "Authorization", value: "Bearer abc" }] });
  expect(remote.target).toBe("https://mcp.example.com/sse?api_key=${API_KEY}");
  expect(remote.secretNames).toEqual(expect.arrayContaining(["Authorization", "API_KEY"]));

  expect(await api.updateMcpServer("Docs-search", { trusted: true, enabled: false })).toMatchObject({ trusted: true, enabled: false });
  expect((await fails(api.updateMcpServer("nope", { trusted: true }))).status).toBe(404);
  expect((await fails(api.updateMcpServer("Docs-search", { name: "x" } as never))).status).toBe(400);

  await api.removeMcpServer("Docs-search");
  expect(secrets.accounts().filter((a) => a.startsWith("mcp/Docs-search/"))).toEqual([]);
  expect((await api.listMcpServers()).map((s) => s.id)).toEqual(["github", "web"]);
  expect((await fails(api.removeMcpServer("../x"))).status).toBe(400);
});

test("skills: built-in and own, switched off for the agent too", async () => {
  expect(await api.listSkills()).toEqual([{ id: "maps", name: "maps", description: "Find places on a map.", origin: "built-in", enabled: true }]);
  expect((await raw("listSkills", [1])).status).toBe(400);
  const added = await api.addSkill({ origin: "folder", location: join(dir, "my-skill") });
  expect(added).toMatchObject({ id: "invoices", origin: "folder", enabled: true });
  expect((await fails(api.addSkill({ origin: "folder", location: join(dir, "my-skill") }))).status).toBe(409);
  expect((await fails(api.addSkill({ origin: "folder", location: join(dir, "nothing-here") }))).status).toBe(400);
  expect((await fails(api.addSkill({ origin: "git", location: "https://github.com/you/skills.git" }))).status).toBe(501);

  expect(await api.setSkillEnabled("maps", false)).toMatchObject({ id: "maps", enabled: false });
  expect((await SkillCatalog.load({ store: skills, builtInDir: builtIn })).list().map((s) => s.name)).toEqual(["invoices"]);
  expect((await fails(api.setSkillEnabled("maps", "no" as never))).status).toBe(400);

  expect((await fails(api.removeSkill("maps"))).message).toBe("Built-in skills can be turned off, not removed");
  await api.removeSkill("invoices");
  expect((await api.listSkills()).map((s) => s.id)).toEqual(["maps"]);
  expect((await fails(api.removeSkill("invoices"))).status).toBe(404);
});

test("permissions: default mode reaches new chats, site rules, outside clients, audit log", async () => {
  expect(await api.getPermissions()).toEqual({ mode: "guard", siteRules: [], clientRules: [{ id: "claude-code", client: "claude-code", mode: "guard", lastUsed: expect.any(String) }], maxMode: null });
  expect((await raw("getPermissions", [1])).status).toBe(400);
  expect((await api.setPermissionMode("ask")).mode).toBe("ask");
  expect(app.info().defaults.mode).toBe("ask");
  expect((await fails(api.setPermissionMode("yolo" as never))).status).toBe(400);

  const first = await api.addSiteRule({ pattern: "GitHub.com", rule: "never" });
  expect(first.siteRules).toMatchObject([{ pattern: "github.com", rule: "never" }]);
  const replaced = await api.addSiteRule({ pattern: "github.com", rule: "allow" });
  expect(replaced.siteRules).toEqual([{ id: first.siteRules[0]!.id, pattern: "github.com", rule: "allow" }]);
  expect((await fails(api.addSiteRule({ pattern: "not a site", rule: "allow" }))).status).toBe(400);
  expect((await api.removeSiteRule(first.siteRules[0]!.id)).siteRules).toEqual([]);
  expect((await fails(api.removeSiteRule(""))).status).toBe(400);

  expect((await api.setClientMode("claude-code", "ask")).clientRules[0]!.mode).toBe("ask");
  expect((await fails(api.setClientMode("codex", "ask"))).status).toBe(404);

  const log = await api.listAuditLog({ limit: 10 });
  expect(log.map((e) => [e.client, e.action, e.outcome])).toEqual([["claude-code", "Type", "declined"], ["Perch", 'Click: button "Send"', "approved"]]);
  expect((await api.listAuditLog({ limit: 10, before: "2026-11-02T00:00:00.000Z" })).map((e) => e.site)).toEqual(["mail.example"]);
  expect((await fails(api.listAuditLog({ limit: 9999 }))).status).toBe(400);
  const exported = await api.exportAuditLog();
  expect(exported).toMatchObject({ type: "application/x-ndjson", entries: 2 });
  expect(exported.name).toMatch(/^perch-activity-\d{4}-\d{2}-\d{2}\.jsonl$/);
  expect(exported.text.trim().split("\n").map((l) => JSON.parse(l).site)).toEqual(["mail.example", "shop.example"]);
  expect((await api.exportAuditLog("csv")).text.split("\r\n")[0]).toBe("time,client,tab,site,url,action,detail,approved,result");
  expect((await fails(api.exportAuditLog("xml" as never))).status).toBe(400);
});

test("memory: settings, pages as markdown, the tidy's log, wipe", async () => {
  expect(await api.getMemorySettings()).toEqual({ extraction: true, historyExtraction: false, dreaming: true });
  expect(await api.setMemorySettings({ dreaming: false })).toEqual({ extraction: true, historyExtraction: false, dreaming: false });
  expect((await fails(api.setMemorySettings({ historyExtraction: true }))).status).toBe(501);
  expect((await fails(api.setMemorySettings({ extraction: "yes" as never }))).status).toBe(400);

  await data.memory.addFacts([{ category: "people", title: "Maya Chen", text: "Sister" }, { category: "user", title: "", text: "Likes tea" }], "user");
  expect((await api.listMemoryPages()).map((p) => [p.path, p.folder])).toEqual([["USER.md", ""], ["people/maya-chen.md", "people"]]);
  expect((await raw("listMemoryPages", [1])).status).toBe(400);
  const doc = await api.readMemoryPage("people/maya-chen.md");
  expect(doc.body).toBe("# Maya Chen\n\n## Current\n- Sister\n");
  expect((await fails(api.readMemoryPage("people/nobody.md"))).status).toBe(404);

  const edited = await api.writeMemoryPage("people/maya-chen.md", "# Maya Chen\n\n## Current\n- Sister\n- Lives in Lisbon\n\n## History\n- Lived in Porto\n");
  expect(edited.body).toBe("# Maya Chen\n\n## Current\n- Sister\n- Lives in Lisbon\n\n## History\n- Lived in Porto\n");
  expect(data.memory.get("people/maya-chen.md")!.current[0]!.source).toBe("user");
  expect((await fails(api.writeMemoryPage("people/maya-chen.md", "- password: hunter22"))).status).toBe(400);

  const page = data.memory.get("people/maya-chen.md")!;
  await data.memory.replacePage({ ...page, current: page.current.slice(0, 1) }, { action: "dream", detail: "Merged two facts about Lisbon", source: "dreaming" });
  const logs = await api.listDreamLogs(5);
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatchObject({ merged: 1, updated: 0, archived: 0, lines: ["people/maya-chen.md: Merged two facts about Lisbon"] });
  expect((await api.getMemorySettings()).lastDream).toBe(logs[0]!.at);
  expect((await fails(api.listDreamLogs(-2))).status).toBe(400);

  await api.deleteMemoryPage("people/maya-chen.md");
  expect((await fails(api.deleteMemoryPage("people/maya-chen.md"))).status).toBe(404);
  await api.wipeMemory();
  expect(await api.listMemoryPages()).toEqual([]);
  expect((await raw("wipeMemory", ["now"])).status).toBe(400);
});

test("setting up memory: a build job, a draft kept until saved", async () => {
  const sources = await api.listSetupSources();
  expect(sources.map((s) => s.id)).toEqual(["history", "bookmarks", "tabs", "chats", "webSearch"]);
  expect(sources.find((s) => s.id === "webSearch")).toMatchObject({ on: false, available: false });
  expect((await raw("listSetupSources", [1])).status).toBe(400);

  expect((await fails(api.startProfileBuild([]))).message).toBe("Turn on at least one source");
  expect((await fails(api.startProfileBuild(["webSearch"]))).status).toBe(400);
  const job = await api.startProfileBuild(["tabs"]);
  const progress = await untilDone(job);
  expect(progress.at(-1)).toMatchObject({ state: "done", summary: ["2 facts to review"] });
  expect(await api.getProfileBuild()).toBeNull();
  expect((await raw("getProfileBuild", [1])).status).toBe(400);

  const draft = await api.getProfileDraft();
  expect(draft.map((f) => [f.group, f.text, f.source])).toEqual([["about", "Reads docs every morning", "Open tabs"], ["people", "Maya is a coworker", "Open tabs"]]);
  expect(data.memory.list()).toEqual([]);
  expect((await raw("getProfileDraft", [1])).status).toBe(400);

  expect((await fails(api.saveProfileDraft([{ id: "x", group: "pets" as never, text: "Cat", source: "" }]))).status).toBe(400);
  const saved = await api.saveProfileDraft([{ ...draft[0]!, text: "Reads the docs every morning" }, { id: "new-fact", group: "writing", text: "Short replies", source: "" }]);
  expect(saved).toEqual({ saved: 2 });
  expect(data.memory.all().flatMap((p) => p.current.map((f) => f.text)).sort()).toEqual(["Reads the docs every morning", "Short replies"]);
  expect(await api.getProfileDraft()).toEqual([]);
  expect((await fails(api.saveProfileDraft([]))).status).toBe(409);

  await untilDone(await api.startProfileBuild(["tabs", "chats"]));
  expect(await api.getProfileDraft()).toHaveLength(2);
  await api.discardProfileDraft();
  expect(await api.getProfileDraft()).toEqual([]);
  expect((await raw("discardProfileDraft", [1])).status).toBe(400);
});

test("routines: daily and interval schedules; event triggers and proposals are not built yet", async () => {
  const daily = await api.saveRoutine({ title: "Morning inbox", prompt: "Summarize my inbox", schedule: { kind: "daily", time: "08:30", days: ["mon", "fri"] } });
  expect(daily).toMatchObject({ title: "Morning inbox", prompt: "Summarize my inbox", schedule: { kind: "daily", time: "08:30", days: ["mon", "fri"] }, enabled: true, nextRun: expect.any(String) });
  const every = await api.saveRoutine({ title: "Prices", prompt: "Check prices", schedule: { kind: "interval", hours: 6 } });
  expect(every.schedule).toEqual({ kind: "interval", hours: 6 });
  const renamed = await api.saveRoutine({ id: daily.id, title: "Inbox", prompt: "Summarize my inbox", schedule: { kind: "daily", time: "07:00", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] } });
  expect(renamed).toMatchObject({ id: daily.id, title: "Inbox", schedule: { kind: "daily", time: "07:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] } });
  expect((await fails(api.saveRoutine({ title: "Mail", prompt: "Sort mail", schedule: { kind: "trigger", event: "mail-received" } }))).status).toBe(501);
  expect((await fails(api.saveRoutine({ title: "", prompt: "x", schedule: { kind: "interval", hours: 2 } }))).message).toBe("Give it a name");
  expect((await fails(api.saveRoutine({ title: "x", prompt: "x", schedule: { kind: "interval", hours: 500 } }))).status).toBe(400);
  expect((await api.listRoutines()).map((r) => r.title).sort()).toEqual(["Inbox", "Prices"]);
  expect((await raw("listRoutines", [1])).status).toBe(400);

  expect(await api.setRoutineEnabled(every.id, false)).toMatchObject({ enabled: false });
  expect((await fails(api.setRoutineEnabled(every.id, "off" as never))).status).toBe(400);

  await api.runRoutine(daily.id);
  const ran = await eventually(() => api.listRoutines(), (list) => list.some((r) => r.id === daily.id && r.lastRun !== undefined));
  expect(ran.find((r) => r.id === daily.id)!.lastRun).toMatchObject({ outcome: "failed" });
  expect((await fails(api.runRoutine("0123456789abcdef0123456789abcdef"))).status).toBe(404);

  await api.deleteRoutine(every.id);
  expect((await fails(api.deleteRoutine(every.id))).status).toBe(404);
  expect((await fails(api.findRoutineProposals())).status).toBe(501);
  expect((await fails(api.acceptProposal("p1"))).status).toBe(501);
  expect((await fails(api.acceptProposal(""))).status).toBe(400);
  expect((await fails(api.dismissProposal("p1"))).status).toBe(501);
  expect((await fails(api.dismissProposal(""))).status).toBe(400);
});

test("import: browsers found, progress as job events, then the suggestion goes away", async () => {
  const browsers = await api.detectBrowsers();
  const chrome = browsers.find((b) => b.id === "chrome")!;
  expect(chrome.profiles).toEqual([{ id: "Default", name: "Person 1" }]);
  expect(chrome.options.find((o) => o.kind === "passwords")).toEqual({ kind: "passwords", available: true, needs: "keychain" });
  expect((await raw("detectBrowsers", [1])).status).toBe(400);
  expect(typeof (await api.getSystemAccess()).fullDiskAccess).toBe("boolean");
  expect((await raw("getSystemAccess", [1])).status).toBe(400);

  expect((await fails(api.startImport({ browser: "chrome", profile: "Nobody", kinds: ["bookmarks"] }))).message).toBe("That browser profile wasn't found");
  expect((await fails(api.startImport({ browser: "chrome", profile: "Default", kinds: ["passwords"], passwordsCsv: "file-1" }))).status).toBe(501);
  expect((await fails(api.startImport({ browser: "netscape" as never, profile: "Default", kinds: ["bookmarks"] }))).status).toBe(400);

  const id = await api.startImport({ browser: "chrome", profile: "Default", kinds: ["bookmarks", "history"] });
  const progress = await untilDone(id);
  const live = events.filter((e) => e.event === `job:${id}`).map((e) => e.data as JobProgress);
  expect(live.some((p) => p.state === "running" && p.step.startsWith("Importing"))).toBe(true);
  expect(live.at(-1)).toMatchObject({ jobId: id, state: "done", done: 2, total: 2 });
  expect(progress.at(-1)!.summary).toEqual(["3 bookmarks", "2 history entries"]);
  expect(await api.getJob(id)).toEqual(live.at(-1)!);
  expect(await api.getJob("job-unknown")).toBeNull();
  expect((await fails(api.getJob(42 as never))).status).toBe(400);
  expect((await api.listSuggestions()).map((s) => s.id)).toEqual([]);
});
