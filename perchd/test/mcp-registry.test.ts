import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addServer, removeServer, RegistryStore, updateServer, type Registry } from "../src/mcp-client/registry";
import { launchFingerprint } from "../src/mcp-client/launch";
import { expandVars, resolveConfig, secretAccounts, secretArgIndexes, storeSecrets, varsIn } from "../src/mcp-client/secrets";
import { parseEntry, sanitizeName, type ServerEntry } from "../src/mcp-client/types";
import { MemoryKeychain } from "../src/secure/keychain";

const dir = mkdtempSync(join(tmpdir(), "perch-registry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const FAKE_TOKEN = "ghp_fakeFakeFake000";
const entry = (name: string, over: Partial<ServerEntry> = {}): ServerEntry => ({
  name,
  config: { transport: "stdio", command: "node", args: ["server.js"], env: {} },
  enabled: true,
  trusted: false,
  addedAt: "2026-11-05T00:00:00.000Z",
  ...over,
});

test("entries are validated at the boundary", () => {
  expect(() => parseEntry({ name: "bad name!", config: { transport: "stdio", command: "x" } })).toThrow("must be 1-32 letters");
  expect(() => parseEntry({ name: "a", config: { transport: "stdio" } })).toThrow("needs a command");
  expect(() => parseEntry({ name: "a", config: { transport: "http", url: "http://example.com/mcp" } })).toThrow("must use https");
  expect(parseEntry({ name: "a", config: { transport: "http", url: "http://127.0.0.1:9/mcp" } }).config).toMatchObject({ transport: "http" });
  expect(() => parseEntry({ name: "a", config: { transport: "stdio", command: "x", env: { "BAD-NAME": "1" } } })).toThrow("invalid name");
  expect(() => parseEntry({ name: "a", config: { transport: "stdio", command: "x", args: [{ secret: 1 }] } })).toThrow("args[0]");
  expect(sanitizeName("my server (prod)")).toBe("my-server-prod");
});

test("registry updates return new objects and keep the old ones unchanged", () => {
  const empty: Registry = { version: 1, servers: [] };
  const one = addServer(empty, entry("github"));
  expect(empty.servers).toHaveLength(0);
  expect(() => addServer(one, entry("github"))).toThrow('a server named "github" already exists');
  const off = updateServer(one, "github", { enabled: false });
  expect(one.servers[0]!.enabled).toBe(true);
  expect(off.servers[0]!.enabled).toBe(false);
  expect(removeServer(off, "github").servers).toHaveLength(0);
  expect(() => updateServer(one, "nope", { trusted: true })).toThrow('no server named "nope"');
});

test("the registry is stored encrypted and holds no secret values", async () => {
  const kc = new MemoryKeychain();
  const store = new RegistryStore(join(dir, "mcp-servers.enc"), kc);
  expect(await store.load()).toEqual({ version: 1, servers: [] });
  const config = await storeSecrets("github", { transport: "stdio", command: "npx", args: ["server-github", "--token", FAKE_TOKEN], env: { GITHUB_TOKEN: FAKE_TOKEN, HOME_DIR: "${HOME}" } }, kc);
  await store.save(addServer(await store.load(), entry("github", { config })));
  const raw = readFileSync(join(dir, "mcp-servers.enc")).toString("latin1");
  expect(raw).not.toContain(FAKE_TOKEN);
  expect(raw).not.toContain("github");
  const loaded = await store.load();
  expect(loaded.servers[0]!.config).toEqual({
    transport: "stdio",
    command: "npx",
    args: ["server-github", "--token", { secret: "mcp/github/arg/2" }],
    env: { GITHUB_TOKEN: { secret: "mcp/github/env/GITHUB_TOKEN" }, HOME_DIR: { env: "HOME" } },
  });
  expect(JSON.stringify(loaded)).not.toContain(FAKE_TOKEN);
  expect(await kc.get("mcp/github/env/GITHUB_TOKEN")).toBe(FAKE_TOKEN);
});

test("registry updates run one at a time, so changes made at once are all kept", async () => {
  const kc = new MemoryKeychain();
  const path = join(dir, "concurrent.enc");
  // Two stores on one file stand in for the daemon and the CLI.
  const a = new RegistryStore(path, kc);
  const b = new RegistryStore(path, kc);
  await a.save(addServer(addServer({ version: 1, servers: [] }, entry("one")), entry("two")));
  await Promise.all([
    a.update((reg) => updateServer(reg, "one", { approvedLaunch: "f1" })),
    b.update((reg) => updateServer(reg, "two", { approvedLaunch: "f2" })),
    a.update((reg) => addServer(reg, entry("three"))),
    b.update(async (reg) => (await Bun.sleep(5), updateServer(reg, "one", { trusted: true }))),
  ]);
  const reg = await a.load();
  expect(reg.servers.map((s) => [s.name, s.approvedLaunch ?? null, s.trusted])).toEqual([["one", "f1", true], ["two", "f2", false], ["three", null, false]]);
  // A failed update changes nothing and does not block the next one.
  await expect(a.update(() => { throw new Error("boom"); })).rejects.toThrow("boom");
  expect((await b.update((r) => removeServer(r, "three"))).servers).toHaveLength(2);
});

test("header values and --flag=value arguments go to the Keychain too", async () => {
  const kc = new MemoryKeychain();
  const http = await storeSecrets("linear", { transport: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: `Bearer ${FAKE_TOKEN}` } }, kc);
  expect(http).toEqual({ transport: "http", url: "https://mcp.example.test/mcp", headers: { Authorization: { secret: "mcp/linear/header/Authorization" } } });
  const stdio = await storeSecrets("x", { transport: "stdio", command: "x", args: [`--api-key=${FAKE_TOKEN}`, "--verbose"], env: {} }, kc);
  expect(stdio.transport === "stdio" && stdio.args).toEqual([{ secret: "mcp/x/arg/0" }, "--verbose"]);
  expect(secretAccounts(http)).toEqual(["mcp/linear/header/Authorization"]);
});

test("credentials passed as --header or -e NAME=value arguments are secret too", () => {
  const args = [
    "mcp-remote", "https://mcp.example.test", "--header", `Authorization: Bearer ${FAKE_TOKEN}`, // 3
    "-H", `X-Api-Key:${FAKE_TOKEN}`, // 5
    `--header=Authorization: Bearer ${FAKE_TOKEN}`, // 6
    "--header", "Accept: text/event-stream", // not a credential
    "run", "-i", "--rm", "-e", `GITHUB_PERSONAL_ACCESS_TOKEN=${FAKE_TOKEN}`, // 13
    "-e", "GITHUB_TOOLSETS=repos", // not a credential
    "-e", "GITHUB_TOKEN", // passes the variable through, holds no value
    `--env=OPENAI_API_KEY=${FAKE_TOKEN}`, // 18
    "ghcr.io/github/github-mcp-server",
  ];
  expect(secretArgIndexes(args)).toEqual([3, 5, 6, 13, 18]);
});

test("configs resolve at launch from the Keychain and the environment", async () => {
  const kc = new MemoryKeychain();
  const config = await storeSecrets("svc", { transport: "stdio", command: "svc", args: ["--token", FAKE_TOKEN, "${WORKSPACE:-default}"], env: { KEY: FAKE_TOKEN, FROM_ENV: "${SVC_URL}" } }, kc);
  const resolved = await resolveConfig(config, kc, { SVC_URL: "https://svc.test" });
  expect(resolved).toEqual({ transport: "stdio", command: "svc", args: ["--token", FAKE_TOKEN, "default"], env: { KEY: FAKE_TOKEN, FROM_ENV: "https://svc.test" } });
  await kc.delete("mcp/svc/env/KEY");
  await expect(resolveConfig(config, kc, {})).rejects.toThrow('The Keychain item for KEY of "svc" is missing');
  expect(expandVars("a ${X} b ${Y:-y} $Z", { X: "1" })).toBe("a 1 b y $Z");
});

test("the launch fingerprint changes when the command, arguments, env or URL change", () => {
  const a = launchFingerprint({ transport: "stdio", command: "node", args: ["a.js"], env: { B: "2", A: { secret: "mcp/x/env/A" } } });
  expect(a).toBe(launchFingerprint({ transport: "stdio", command: "node", args: ["a.js"], env: { A: { secret: "mcp/x/env/A" }, B: "2" } }));
  expect(a).not.toBe(launchFingerprint({ transport: "stdio", command: "node", args: ["b.js"], env: { B: "2", A: { secret: "mcp/x/env/A" } } }));
  // Adding NODE_OPTIONS or changing a plain env value changes what runs, so it asks again.
  expect(a).not.toBe(launchFingerprint({ transport: "stdio", command: "node", args: ["a.js"], env: { B: "2", A: { secret: "mcp/x/env/A" }, NODE_OPTIONS: "--require /tmp/x.js" } }));
  expect(a).not.toBe(launchFingerprint({ transport: "stdio", command: "node", args: ["a.js"], env: { B: "3", A: { secret: "mcp/x/env/A" } } }));
  const r = launchFingerprint({ transport: "http", url: "https://a.test/mcp", headers: {} });
  expect(r).not.toBe(launchFingerprint({ transport: "http", url: "https://b.test/mcp", headers: {} }));
  expect(r).not.toBe(launchFingerprint({ transport: "http", url: "https://a.test/mcp", headers: { "X-Key": "${OPENAI_API_KEY}" } }));
});

test("every variable a value reads is found, not only values that are just a variable", () => {
  expect(varsIn("Bearer ${OPENAI_API_KEY}")).toEqual(["OPENAI_API_KEY"]);
  expect(varsIn("${A}/x/${B:-d}/${A}")).toEqual(["A", "B"]);
  expect(varsIn("$HOME")).toEqual(["HOME"]);
  expect(varsIn("plain $5 text")).toEqual([]);
});
