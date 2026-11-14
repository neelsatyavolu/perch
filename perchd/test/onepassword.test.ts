import { expect, test } from "bun:test";
import { explain, fillablePage, findOp, hostRank, listAccounts, listVaults, OnePassword, OnePasswordAccounts, onePasswordStatus, opSaid, SETUP_HELP, verifyAccount, type OpResult, type OpRun } from "../src/secure/onepassword";

const ID_A = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
const ID_B = "bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ID_C = "cccccccccccccccccccccccccc";
const ACCOUNT = "E3OXZANXQRDOBNXQMPXZ6YBHTY";

const ok = (value: unknown): OpResult => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });

function fakeOp(answer: (args: readonly string[]) => OpResult) {
  const calls: (readonly string[])[] = [];
  const run: OpRun = async (args) => (calls.push(args), answer(args));
  return { run, calls };
}

const ITEMS = [
  { id: ID_A, title: "GitHub (old)", category: "LOGIN", urls: [{ href: "https://github.com" }], additional_information: "old@example.com", updated_at: "2024-01-01T00:00:00Z" },
  { id: ID_B, title: "GitHub", category: "LOGIN", urls: [{ href: "https://github.com/login", primary: true }], additional_information: "grace@example.com", updated_at: "2026-01-01T00:00:00Z" },
  { id: ID_C, title: "Gist", category: "LOGIN", urls: [{ href: "gist.github.com" }], additional_information: "gist", updated_at: "2026-06-01T00:00:00Z" },
  { id: "not-an-id", title: "Bad", urls: [{ href: "https://github.com" }] },
  { id: "dddddddddddddddddddddddddd", title: "Lookalike", urls: [{ href: "https://notgithub.com" }] },
];

test("op is found on the PATH, or where Homebrew puts it when an app's PATH is short", () => {
  const has = (set: string[]) => (p: string) => set.includes(p);
  expect(findOp({ PATH: "/usr/bin:/custom/bin" }, has(["/custom/bin/op"]))).toBe("/custom/bin/op");
  expect(findOp({ PATH: "/usr/bin" }, has(["/opt/homebrew/bin/op"]))).toBe("/opt/homebrew/bin/op");
  expect(findOp({ PATH: "relative/bin" }, has(["relative/bin/op"]))).toBeNull();
  expect(findOp({}, () => false)).toBeNull();
});

test("hosts match exactly (ignoring www.), never a subdomain, lookalike or bare suffix", () => {
  expect(hostRank("https://github.com/login", "github.com")).toBe(1);
  expect(hostRank("www.github.com", "github.com")).toBe(1);
  expect(hostRank("https://github.com", "gist.github.com")).toBe(0);
  expect(hostRank("https://alice.github.io", "mallory.github.io")).toBe(0);
  expect(hostRank("https://github.io", "mallory.github.io")).toBe(0);
  expect(hostRank("https://notgithub.com", "github.com")).toBe(0);
  expect(hostRank("https://github.com.evil.io", "github.com")).toBe(0);
  expect(hostRank("com", "github.com")).toBe(0);
  expect(hostRank("::::", "github.com")).toBe(0);
});

test("only HTTPS pages, or a server on this Mac, are ever filled", () => {
  expect(fillablePage("https://github.com/login")?.hostname).toBe("github.com");
  expect(fillablePage("http://localhost:3000/")?.hostname).toBe("localhost");
  expect(fillablePage("http://github.com/login")).toBeNull();
  expect(fillablePage("file:///etc/passwd")).toBeNull();
  expect(fillablePage("not a url")).toBeNull();
});

test("logins: items for the page's host, newest first, with the account named on every call", async () => {
  const op = fakeOp(() => ok(ITEMS));
  const logins = await new OnePassword(op.run, ACCOUNT).logins("https://github.com/login");
  expect(logins.map((l) => [l.id, l.rank, l.username])).toEqual([[ID_B, 1, "grace@example.com"], [ID_A, 1, "old@example.com"]]);
  expect(op.calls[0]).toEqual(["item", "list", "--categories", "Login", "--account", ACCOUNT, "--format", "json"]);
  expect((await new OnePassword(op.run, ACCOUNT).logins("https://gist.github.com/")).map((l) => l.id)).toEqual([ID_C]);
});

test("logins on a page Perch won't fill never ask 1Password", async () => {
  const op = fakeOp(() => ok(ITEMS));
  expect(await new OnePassword(op.run, ACCOUNT).logins("http://github.com/login")).toEqual([]);
  expect(op.calls).toEqual([]);
});

test("credentials and one-time codes come from the item's fields", async () => {
  const item = {
    fields: [
      { id: "username", purpose: "USERNAME", value: "grace@example.com" },
      { id: "password", purpose: "PASSWORD", value: "hunter2" },
      { id: "notes", purpose: "NOTES", value: "ignored" },
      { id: "one-time", type: "OTP", totp: "246810" },
    ],
  };
  const op = fakeOp(() => ok(item));
  const p = new OnePassword(op.run, ACCOUNT);
  expect(await p.credentials(ID_B)).toEqual({ username: "grace@example.com", password: "hunter2" });
  expect(await p.otp(ID_B)).toBe("246810");
  expect(op.calls[0]).toEqual(["item", "get", ID_B, "--account", ACCOUNT, "--reveal", "--format", "json"]);
  expect(await new OnePassword(fakeOp(() => ok({ fields: [] })).run, ACCOUNT).otp(ID_B)).toBeNull();
  await expect(p.credentials("--vault=x")).rejects.toThrow("That isn't a 1Password item.");
  expect(() => new OnePassword(op.run, "--account x")).toThrow("That isn't a 1Password account.");
});

test("op's errors become plain reasons, never what it printed", async () => {
  expect(explain({ code: 1, stdout: "", stderr: "[ERROR] error initializing client: connecting to desktop app: ..." })).toBe(SETUP_HELP);
  expect(explain({ code: 1, stdout: "", stderr: "[ERROR] authorization prompt dismissed, please try again" })).toBe("1Password didn't allow Perch this time.");
  expect(explain({ code: 143, stdout: "", stderr: "" })).toBe("1Password didn't answer. Unlock it and try again.");
  const secret = fakeOp(() => ({ code: 1, stdout: "hunter2", stderr: "something odd" }));
  const error = await new OnePassword(secret.run, ACCOUNT).credentials(ID_B).catch((e: Error) => e.message);
  expect(error).toBe("1Password couldn't be read.");
  await expect(verifyAccount(fakeOp(() => ({ code: 1, stdout: "", stderr: "authorization denied" })).run, ACCOUNT)).rejects.toThrow("didn't allow");
});

test("status: not installed, no accounts yet, or the accounts to pick from", async () => {
  expect(await onePasswordStatus(null)).toMatchObject({ installed: false, accounts: [] });
  // No accounts and nothing on op's error output: what it printed goes in the detail, for the log.
  expect(await onePasswordStatus(fakeOp(() => ok([])).run)).toEqual({ installed: true, accounts: [], error: SETUP_HELP, detail: 'op account list printed "[]"' });
  const accounts = [{ url: "my.1password.com", email: "grace@example.com", user_uuid: ACCOUNT, account_uuid: "ACC" }, { email: "bad", user_uuid: "--evil" }];
  expect(await listAccounts(fakeOp(() => ok(accounts)).run)).toEqual([{ id: ACCOUNT, email: "grace@example.com", url: "my.1password.com" }]);
});

const VAULT_A = "vaaaaaaaaaaaaaaaaaaaaaaaaa";
const VAULT_B = "vbbbbbbbbbbbbbbbbbbbbbbbbb";

test("op's own words come along, without its timestamp", () => {
  expect(opSaid({ code: 1, stdout: "", stderr: "[ERROR] 2026/11/12 17:40:51 connecting to desktop app: read: connection reset\nmore" })).toBe("connecting to desktop app: read: connection reset");
  expect(opSaid({ code: 0, stdout: "", stderr: "" })).toBeUndefined();
});

test("status with no accounts keeps what 1Password said about why", async () => {
  const status = await onePasswordStatus(fakeOp(() => ({ code: 0, stdout: "[]", stderr: "[WARN] 2026/11/12 17:40:51 app integration is off" })).run);
  expect(status).toEqual({ installed: true, accounts: [], error: SETUP_HELP, detail: "app integration is off" });
  const failed = await onePasswordStatus(fakeOp(() => ({ code: 1, stdout: "", stderr: "[ERROR] 2026/11/12 17:40:51 error initializing client: connecting to desktop app: timeout" })).run);
  expect(failed).toMatchObject({ error: SETUP_HELP, detail: "error initializing client: connecting to desktop app: timeout" });
});

test("vaults list, and logins come only from the vaults picked", async () => {
  const items = ITEMS.map((item, i) => ({ ...item, vault: { id: i % 2 ? VAULT_B : VAULT_A } }));
  const op = fakeOp((args) => ok(args[0] === "vault" ? [{ id: VAULT_A, name: "Private" }, { id: "bad", name: "x" }] : items));
  expect(await listVaults(op.run, ACCOUNT)).toEqual([{ id: VAULT_A, name: "Private" }]);
  const onlyB = await new OnePassword(op.run, ACCOUNT, [VAULT_B]).logins("https://github.com/login");
  expect(onlyB.map((l) => l.id)).toEqual([ID_B]);
  const all = await new OnePassword(op.run, ACCOUNT, null).logins("https://github.com/login");
  expect(all.map((l) => l.id)).toEqual([ID_B, ID_A]);
});

test("several accounts: logins from each, secrets from the right one, a failing account skipped", async () => {
  const OTHER = "OTHERACCOUNT00000000000000";
  const calls: (readonly string[])[] = [];
  const run: OpRun = async (args) => {
    calls.push(args);
    const account = args[args.indexOf("--account") + 1];
    if (args[0] === "item" && args[1] === "list") return account === ACCOUNT ? ok([ITEMS[1]]) : ok([{ ...ITEMS[0], id: ID_C }]);
    return ok({ fields: [{ purpose: "USERNAME", value: `${account}-user` }, { purpose: "PASSWORD", value: "pw" }] });
  };
  const both = new OnePasswordAccounts(run, [{ account: ACCOUNT, vaults: null }, { account: OTHER, vaults: null }]);
  const logins = await both.logins("https://github.com/");
  expect(logins.map((l) => l.id)).toEqual([`${ACCOUNT}/${ID_B}`, `${OTHER}/${ID_C}`]);
  expect((await both.credentials(`${OTHER}/${ID_C}`)).username).toBe(`${OTHER}-user`);
  expect(calls.at(-1)).toEqual(["item", "get", ID_C, "--account", OTHER, "--reveal", "--format", "json"]);
  await expect(both.credentials(`NOBODY/${ID_C}`)).rejects.toThrow("That 1Password item is gone.");

  const halfBroken: OpRun = async (args) => (args.includes(OTHER) ? { code: 1, stdout: "", stderr: "[ERROR] locked" } : ok([ITEMS[1]]));
  const partly = new OnePasswordAccounts(halfBroken, [{ account: ACCOUNT, vaults: null }, { account: OTHER, vaults: null }]);
  expect((await partly.logins("https://github.com/")).map((l) => l.id)).toEqual([`${ACCOUNT}/${ID_B}`]);
  const broken = new OnePasswordAccounts(async () => ({ code: 1, stdout: "", stderr: "[ERROR] authorization denied" }), [{ account: ACCOUNT, vaults: null }]);
  await expect(broken.logins("https://github.com/")).rejects.toThrow("didn't allow");
});
