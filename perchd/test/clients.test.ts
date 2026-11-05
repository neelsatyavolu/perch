import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientRegistry, newToken } from "../src/daemon/clients";
import { MacKeychain, MemoryKeychain, type Runner } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";

const dir = mkdtempSync(join(tmpdir(), "perch-clients-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("paths live under PERCH_HOME and the socket path fits a Unix socket", () => {
  const paths = perchPaths({ PERCH_HOME: dir });
  expect(paths.socket).toBe(join(dir, "run", "perchd.sock"));
  expect(paths.sessionsFile).toBe(join(dir, "run", "sessions.json"));
  expect(() => perchPaths({ PERCH_HOME: `/tmp/${"x".repeat(120)}` })).toThrow("too long for a socket");
  expect(perchPaths({ HOME: "/Users/someone" }).home).toBe("/Users/someone/Library/Application Support/Perch");
});

test("the macOS keychain never puts a secret on a command line", async () => {
  const calls: { args: string[]; stdin?: string }[] = [];
  const stored = new Map<string, string>();
  const run: Runner = async (args, stdin) => {
    calls.push({ args, stdin });
    if (args[0] === "-i") {
      const m = stdin!.match(/-a "([^"]+)" -w "([^"]+)"/)!;
      stored.set(m[1]!, m[2]!);
      return { code: 0, stdout: "", stderr: "" };
    }
    const account = args[args.indexOf("-a") + 1]!;
    if (args[0] === "find-generic-password") return stored.has(account) ? { code: 0, stdout: `${stored.get(account)}\n`, stderr: "" } : { code: 44, stdout: "", stderr: "not found" };
    stored.delete(account);
    return { code: 0, stdout: "", stderr: "" };
  };
  const keychain = new MacKeychain("Perch clients", run);
  const secret = newToken();
  await keychain.set("claude-code", secret);
  expect(await keychain.get("claude-code")).toBe(secret);
  expect(await keychain.get("missing")).toBeNull();
  await keychain.delete("claude-code");
  expect(await keychain.get("claude-code")).toBeNull();
  for (const call of calls) expect(call.args.join(" ")).not.toContain(secret);
  expect(calls[0]!.stdin).toContain('-s "Perch clients"');
  await expect(keychain.set('bad" name', secret)).rejects.toThrow("client name");
  await expect(keychain.set("ok", 'x" -w "y')).rejects.toThrow("token");
});

test("first use registers a client in Guard; verify is exact and revoke sticks", async () => {
  const keychain = new MemoryKeychain();
  const registry = new ClientRegistry(join(dir, "clients.json"), keychain);
  const token = await registry.token("claude-code");
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(await registry.token("claude-code")).toBe(token);

  const ok = await registry.verify("claude-code", token);
  expect(ok).toMatchObject({ name: "claude-code", mode: "guard" });
  expect(await registry.verify("claude-code", `${token.slice(0, -1)}A`)).toEqual({ error: "Perch did not accept this client's token." });
  expect(await registry.verify("nobody", token)).toEqual({ error: "Perch did not accept this client's token." });
  expect(await registry.verify("Bad Name", token)).toEqual({ error: 'Client names use lowercase letters, digits and dashes, like "claude-code".' });

  registry.setMode("claude-code", "ask");
  expect(registry.list().find((c) => c.name === "claude-code")?.mode).toBe("ask");

  await registry.revoke("claude-code");
  expect(await keychain.get("claude-code")).toBeNull();
  const again = await registry.token("claude-code");
  expect(await registry.verify("claude-code", again)).toEqual({ error: 'Client "claude-code" was revoked. Run: perch clients allow claude-code' });
  registry.allow("claude-code");
  expect(await registry.verify("claude-code", again)).toMatchObject({ name: "claude-code" });

  const file = join(dir, "clients.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain(again);
});
