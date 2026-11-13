/**
 * 1Password as a source of logins for the agent's sign_in and fill_code (agent/fill-tools.ts).
 *
 * Perch talks to the 1Password desktop app through its command-line tool, `op`, with the app's
 * "Integrate with 1Password CLI" setting on. The app then asks for Touch ID (or the account
 * password) the first time Perch reads, and again after it locks, so Perch never holds a
 * 1Password secret of its own. Values read here go straight into the page's form; they are
 * never logged, stored, or returned to the model.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

export type OpResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
export type OpRun = (args: readonly string[], opts?: { readonly timeoutMs?: number }) => Promise<OpResult>;

export type OpAccount = { readonly id: string; readonly email: string; readonly url: string };
/** A Login item for the page's host, without its secrets. */
export type OpLogin = { readonly id: string; readonly title: string; readonly username: string; readonly rank: number };
export type OpCredentials = { readonly username: string; readonly password: string };

/** Touch ID can take a while; the app's own prompt times out before this. */
const READ_TIMEOUT_MS = 90_000;
const STATUS_TIMEOUT_MS = 10_000;
const ITEM_ID = /^[a-z0-9]{26}$/i;
const ACCOUNT_ID = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;

export const SETUP_HELP =
  "In the 1Password app, open Settings › Developer and turn on Integrate with 1Password CLI. Then try again.";
const INSTALL_HELP = "Install 1Password's command-line tool (brew install 1password-cli), then try again.";

/** A reason for the person, and what `op` itself said (its error output, which never holds a secret). */
export class OnePasswordError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(message);
  }
}

/** `op`'s own words: its first error line, without the "[ERROR] 2026/11/12 17:40:51" prefix, kept short. */
export function opSaid(result: OpResult): string | undefined {
  const line = result.stderr.split("\n").map((l) => l.trim()).find(Boolean);
  if (!line) return undefined;
  return line.replace(/^\[(ERROR|WARN)\]\s*\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2}\s*/, "").slice(0, 240);
}

/** Where `op` is: the PATH first, then the places Homebrew and the installer put it (an app's PATH is short). */
export function findOp(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean = existsSync): string | null {
  const dirs = [...(env.PATH ?? "").split(":").filter(Boolean), "/opt/homebrew/bin", "/usr/local/bin", ...(env.HOME ? [join(env.HOME, ".local", "bin")] : [])];
  for (const dir of dirs) {
    const path = join(dir, "op");
    if (path.startsWith("/") && exists(path)) return path;
  }
  return null;
}

/** Runs `op` with arguments only, never through a shell. */
export function opRunner(path: string, env: Readonly<Record<string, string | undefined>> = process.env): OpRun {
  return async (args, opts = {}) => {
    const proc = Bun.spawn([path, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...env, OP_FORMAT: "json" } });
    const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? READ_TIMEOUT_MS);
    try {
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
      return { code, stdout, stderr };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** A person-facing reason from `op`'s error output. Never includes what `op` printed on stdout. */
export function explain(result: OpResult): string {
  const text = result.stderr.toLowerCase();
  if (result.code === 143 || result.code === 137 || text.includes("timed out")) return "1Password didn't answer. Unlock it and try again.";
  if (text.includes("dismissed") || text.includes("cancel") || text.includes("denied") || text.includes("authorization")) return "1Password didn't allow Perch this time.";
  if (text.includes("desktop app") || text.includes("connecting to") || text.includes("not signed in") || text.includes("no accounts")) return SETUP_HELP;
  if (text.includes("isn't an item") || text.includes("not found")) return "That 1Password item is gone.";
  return "1Password couldn't be read.";
}

function parse<T>(result: OpResult): T {
  if (result.code !== 0) throw new OnePasswordError(explain(result), opSaid(result));
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw new OnePasswordError("1Password answered in a way Perch doesn't understand.");
  }
}

export async function listAccounts(run: OpRun): Promise<OpAccount[]> {
  return accountsFrom(await run(["account", "list", "--format", "json"], { timeoutMs: STATUS_TIMEOUT_MS }));
}

function accountsFrom(result: OpResult): OpAccount[] {
  const raw = parse<unknown>(result);
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((a) => {
    const o = a as Record<string, unknown>;
    const id = typeof o.user_uuid === "string" ? o.user_uuid : typeof o.account_uuid === "string" ? o.account_uuid : null;
    if (!id || !ACCOUNT_ID.test(id)) return [];
    return [{ id, email: typeof o.email === "string" ? o.email : "", url: typeof o.url === "string" ? o.url : "" }];
  });
}

const stripWww = (host: string) => host.replace(/^www\./, "");

/**
 * Whether a saved address is for the page's host: 1 for the same host (ignoring "www."), else 0.
 * Subdomains don't match each other: on shared hosts (github.io, vercel.app and many more) a
 * sibling subdomain belongs to someone else, and telling those apart needs the full public
 * suffix list. A login for login.example.com is offered on login.example.com only.
 */
export function hostRank(saved: string, pageHost: string): number {
  let host: string;
  try {
    host = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(saved) ? saved : `https://${saved}`).hostname.toLowerCase();
  } catch {
    return 0;
  }
  const a = stripWww(host);
  const b = stripWww(pageHost.toLowerCase());
  return a && a === b ? 1 : 0;
}

/** Pages the agent may fill: HTTPS, or a server on this Mac. */
export function fillablePage(pageUrl: string): URL | null {
  try {
    const url = new URL(pageUrl);
    if (url.protocol === "https:") return url;
    if (url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return url;
    return null;
  } catch {
    return null;
  }
}

type ListedItem = { id?: unknown; title?: unknown; urls?: unknown; additional_information?: unknown; updated_at?: unknown; vault?: { id?: unknown } };
type ItemField = { purpose?: unknown; type?: unknown; value?: unknown; totp?: unknown };

export type OpVault = { readonly id: string; readonly name: string };

/** The account's vaults. Asks 1Password, so may show Touch ID. */
export async function listVaults(run: OpRun, account: string): Promise<OpVault[]> {
  if (!ACCOUNT_ID.test(account)) throw new OnePasswordError("That isn't a 1Password account.");
  const raw = parse<unknown>(await run(["vault", "list", "--account", account, "--format", "json"]));
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v) => {
    const o = v as Record<string, unknown>;
    return typeof o.id === "string" && ITEM_ID.test(o.id) && typeof o.name === "string" ? [{ id: o.id, name: o.name.slice(0, 120) }] : [];
  });
}

export class OnePassword {
  /** `vaults`: the vault ids the agent may use in this account; null for every vault. */
  constructor(private readonly run: OpRun, readonly account: string, private readonly vaults: readonly string[] | null = null) {
    if (!ACCOUNT_ID.test(account)) throw new OnePasswordError("That isn't a 1Password account.");
  }

  /** Logins saved for the page's host, newest first. Asks 1Password, so may show Touch ID. */
  async logins(pageUrl: string): Promise<OpLogin[]> {
    const page = fillablePage(pageUrl);
    if (!page) return [];
    const items = parse<unknown>(await this.run(["item", "list", "--categories", "Login", "--account", this.account, "--format", "json"]));
    if (!Array.isArray(items)) return [];
    const allowed = this.vaults ? new Set(this.vaults) : null;
    const ranked = (items as ListedItem[]).flatMap((item) => {
      if (typeof item.id !== "string" || !ITEM_ID.test(item.id)) return [];
      if (allowed && !(typeof item.vault?.id === "string" && allowed.has(item.vault.id))) return [];
      const urls = Array.isArray(item.urls) ? (item.urls as { href?: unknown }[]) : [];
      const rank = Math.max(0, ...urls.map((u) => (typeof u.href === "string" ? hostRank(u.href, page.hostname) : 0)));
      if (rank === 0) return [];
      const updated = typeof item.updated_at === "string" ? Date.parse(item.updated_at) || 0 : 0;
      return [{ id: item.id, title: typeof item.title === "string" ? item.title : "", username: typeof item.additional_information === "string" ? item.additional_information : "", rank, updated }];
    });
    return ranked.sort((a, b) => b.rank - a.rank || b.updated - a.updated).map(({ updated: _, ...login }) => login);
  }

  /** The item's username and password. */
  async credentials(id: string): Promise<OpCredentials> {
    const fields = await this.fields(id);
    const value = (purpose: string) => {
      const f = fields.find((x) => x.purpose === purpose && typeof x.value === "string");
      return f ? (f.value as string) : "";
    };
    return { username: value("USERNAME"), password: value("PASSWORD") };
  }

  /** The item's current one-time code, or null when it has none. */
  async otp(id: string): Promise<string | null> {
    const field = (await this.fields(id)).find((f) => f.type === "OTP" && typeof f.totp === "string" && /^\d{6,8}$/.test(f.totp));
    return field ? (field.totp as string) : null;
  }

  private async fields(id: string): Promise<ItemField[]> {
    if (!ITEM_ID.test(id)) throw new OnePasswordError("That isn't a 1Password item.");
    const item = parse<{ fields?: unknown }>(await this.run(["item", "get", id, "--account", this.account, "--reveal", "--format", "json"]));
    return Array.isArray(item.fields) ? (item.fields as ItemField[]) : [];
  }
}

export type OnePasswordStatus = { readonly installed: boolean; readonly accounts: readonly OpAccount[]; readonly error?: string; readonly detail?: string };

/** Whether `op` is installed and which accounts the 1Password app has. Shows no prompt. */
export async function onePasswordStatus(run: OpRun | null): Promise<OnePasswordStatus> {
  if (!run) return { installed: false, accounts: [], error: INSTALL_HELP };
  try {
    const result = await run(["account", "list", "--format", "json"], { timeoutMs: STATUS_TIMEOUT_MS });
    const accounts = accountsFrom(result);
    if (accounts.length) return { installed: true, accounts };
    // No accounts: 1Password's own note on why (an app integration that is off, say) goes along.
    const detail = opSaid(result);
    return { installed: true, accounts, error: SETUP_HELP, ...(detail ? { detail } : {}) };
  } catch (error) {
    const detail = error instanceof OnePasswordError ? error.detail : error instanceof Error ? error.message : undefined;
    return { installed: true, accounts: [], error: error instanceof OnePasswordError ? error.message : SETUP_HELP, ...(detail ? { detail } : {}) };
  }
}

/** Checks Perch can read the account: 1Password asks for Touch ID now, while the person is looking. */
export async function verifyAccount(run: OpRun, account: string): Promise<void> {
  if (!ACCOUNT_ID.test(account)) throw new OnePasswordError("That isn't a 1Password account.");
  parse<unknown>(await run(["vault", "list", "--account", account, "--format", "json"]));
}

/** An account the agent may use, and in it the vault ids it may read (null for every vault). */
export type OpChoice = { readonly account: string; readonly vaults: readonly string[] | null };

/**
 * Logins and codes across every account the person chose. Accounts are asked one after another, so
 * 1Password shows one prompt at a time; an account that fails is skipped when another answers.
 * A login's id carries its account ("<account>/<item>"), so its secrets are read from the right one.
 */
export class OnePasswordAccounts {
  private readonly clients: readonly OnePassword[];

  constructor(run: OpRun, choices: readonly OpChoice[]) {
    this.clients = choices.map((c) => new OnePassword(run, c.account, c.vaults));
  }

  async logins(pageUrl: string): Promise<OpLogin[]> {
    const found: OpLogin[] = [];
    let failure: unknown = null;
    for (const client of this.clients) {
      try {
        for (const login of await client.logins(pageUrl)) found.push({ ...login, id: `${client.account}/${login.id}` });
      } catch (error) {
        failure ??= error;
      }
    }
    if (found.length === 0 && failure) throw failure;
    // Stable sort: best match first, and among equals the order the person listed their accounts.
    return found.sort((a, b) => b.rank - a.rank);
  }

  async credentials(id: string): Promise<OpCredentials> {
    const [client, item] = this.split(id);
    return client.credentials(item);
  }

  async otp(id: string): Promise<string | null> {
    const [client, item] = this.split(id);
    return client.otp(item);
  }

  private split(id: string): [OnePassword, string] {
    const slash = id.indexOf("/");
    const client = this.clients.find((c) => c.account === id.slice(0, slash));
    if (slash < 0 || !client) throw new OnePasswordError("That 1Password item is gone.");
    return [client, id.slice(slash + 1)];
  }
}
