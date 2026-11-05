import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { ClientRegistry, newToken, raisesMode } from "../src/daemon/clients";
import { dialogScript, macConfirm } from "../src/daemon/confirm";
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

  await registry.setMode("claude-code", "ask");
  expect(registry.list().find((c) => c.name === "claude-code")?.mode).toBe("ask");

  await registry.revoke("claude-code");
  expect(await keychain.get("claude-code")).toBeNull();
  const again = await registry.token("claude-code");
  expect(await registry.verify("claude-code", again)).toEqual({ error: 'Client "claude-code" was revoked. Run: perch clients allow claude-code' });
  await registry.allow("claude-code");
  expect(await registry.verify("claude-code", again)).toMatchObject({ name: "claude-code" });

  const file = join(dir, "clients.json");
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(readFileSync(file, "utf8")).not.toContain(again);
});

test("a mode raised by editing clients.json is lowered to Guard, and a running perchd never rereads it", async () => {
  const file = join(dir, "sealed.json");
  const keychain = new MemoryKeychain();
  const seal = new MemoryKeychain();
  const daemonSide = new ClientRegistry(file, keychain, seal);
  await daemonSide.load();
  await daemonSide.verify("codex", await daemonSide.token("codex"));
  await daemonSide.verify("grok", await daemonSide.token("grok"));
  await daemonSide.setMode("grok", "skip");

  // Another program writes the file while perchd runs: perchd keeps what it knows.
  const edited = JSON.parse(readFileSync(file, "utf8"));
  edited.clients = edited.clients.map((c: { name: string }) => ({ ...c, mode: "skip" }));
  writeFileSync(file, JSON.stringify(edited));
  expect(daemonSide.list().find((c) => c.name === "codex")?.mode).toBe("guard");

  // The next perchd sees a broken seal: nothing above Guard survives, not even grok's real skip.
  const restarted = new ClientRegistry(file, keychain, seal);
  await restarted.load();
  expect(restarted.list().map((c) => [c.name, c.mode])).toEqual([["codex", "guard"], ["grok", "guard"]]);

  // A file perchd wrote itself loads as written.
  await restarted.setMode("grok", "skip");
  const again = new ClientRegistry(file, keychain, seal);
  await again.load();
  expect(again.find("grok").mode).toBe("skip");
  expect(readFileSync(file, "utf8")).not.toContain((await seal.get("registry"))!);
});

test("raising a mode is ask → guard → skip", () => {
  expect(raisesMode("guard", "skip")).toBe(true);
  expect(raisesMode("ask", "guard")).toBe(true);
  expect(raisesMode("skip", "guard")).toBe(false);
  expect(raisesMode("guard", "guard")).toBe(false);
});

test("the confirm dialog defaults to Don't Allow and only an Allow click counts", async () => {
  const script = dialogScript('Let "x\\" do more?\nreally');
  expect(script).toContain('default button "Don\'t Allow"');
  expect(script).toContain('"Let \\"x\\\\\\" do more? really"');
  const answer = (code: number, stdout: string) => macConfirm(async () => ({ code, stdout }));
  expect(await answer(0, "button returned:Allow, gave up:false")("?")).toBe(true);
  expect(await answer(0, "button returned:, gave up:true")("?")).toBe(false);
  expect(await answer(1, "")("?")).toBe(false);
  expect(await macConfirm(async () => Promise.reject(new Error("no screen")))("?")).toBe(false);
});
