/**
 * Secret stores for perchd. Outside clients' tokens live in FileKeychain (one 0600 file each), which
 * the perch command and perchd share. MacKeychain drives the `security` tool in its interactive
 * mode with commands on stdin, so a secret never appears in a process list.
 */

import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownService } from "../secure/service-name";

export interface Keychain {
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (args: string[], stdin?: string) => Promise<RunResult>;

export const CLIENT_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;
/** `security` exits with 44 when an item is not in the keychain. */
const NOT_FOUND = 44;

const runSecurity: Runner = async (args, stdin) => {
  const child = Bun.spawn(["/usr/bin/security", ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined) {
    const sink = child.stdin as import("bun").FileSink;
    sink.write(stdin);
    await sink.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
};

function checkAccount(account: string): void {
  if (!CLIENT_NAME.test(account)) throw new Error(`"${account}" is not a valid client name`);
}

export class MacKeychain implements Keychain {
  readonly service: string;
  constructor(service = "Perch clients", private readonly run: Runner = runSecurity) {
    this.service = ownService(service);
  }

  async get(account: string): Promise<string | null> {
    checkAccount(account);
    const r = await this.run(["find-generic-password", "-s", this.service, "-a", account, "-w"]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`The Keychain could not be read (security exited ${r.code})`);
    return r.stdout.replace(/\n$/, "");
  }

  async set(account: string, secret: string): Promise<void> {
    checkAccount(account);
    if (!SECRET.test(secret)) throw new Error("A client token must be 16 to 128 URL-safe characters");
    await this.run(["-i"], `add-generic-password -U -s "${this.service}" -a "${account}" -w "${secret}"\n`);
    // Interactive mode exits 0 even when a command fails, so read the item back.
    if ((await this.get(account)) !== secret) throw new Error("The Keychain did not save the client token");
  }

  async delete(account: string): Promise<void> {
    checkAccount(account);
    const r = await this.run(["delete-generic-password", "-s", this.service, "-a", account]);
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`The Keychain item could not be removed (security exited ${r.code})`);
  }
}

/**
 * Outside clients' tokens, one file each in a folder only the user can open (0700, files 0600).
 * The perch command and perchd both use it, so a token the command makes is the one perchd
 * checks; neither needs the Keychain, so no Keychain prompt can come from a client connecting.
 * The same user could read these through `security` before; a 0600 file is no weaker.
 */
export class FileKeychain implements Keychain {
  constructor(readonly dir: string) {}

  async get(account: string): Promise<string | null> {
    checkAccount(account);
    try {
      return readFileSync(join(this.dir, account), "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  async set(account: string, secret: string): Promise<void> {
    checkAccount(account);
    if (!SECRET.test(secret)) throw new Error("A client token must be 16 to 128 URL-safe characters");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
    const file = join(this.dir, account);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, secret, { mode: 0o600 });
    renameSync(temp, file);
  }

  async delete(account: string): Promise<void> {
    checkAccount(account);
    rmSync(join(this.dir, account), { force: true });
  }
}

/** For tests: the same rules, kept in memory. */
export class MemoryKeychain implements Keychain {
  private items = new Map<string, string>();

  async get(account: string): Promise<string | null> {
    checkAccount(account);
    return this.items.get(account) ?? null;
  }

  async set(account: string, secret: string): Promise<void> {
    checkAccount(account);
    if (!SECRET.test(secret)) throw new Error("A client token must be 16 to 128 URL-safe characters");
    this.items = new Map(this.items).set(account, secret);
  }

  async delete(account: string): Promise<void> {
    const next = new Map(this.items);
    next.delete(account);
    this.items = next;
  }
}

/**
 * The same store, kept in the profile's sealed secrets file (plan 3b, task 3) instead of the
 * Keychain. `service` keeps the client tokens apart from the registry's seal key.
 */
export class SealedKeychain implements Keychain {
  constructor(
    private readonly secrets: import("../secure/sealed-secrets").SealedSecrets,
    readonly service = "Perch clients",
  ) {}

  async get(account: string): Promise<string | null> {
    checkAccount(account);
    return this.secrets.get(`${this.service}/${account}`);
  }

  async set(account: string, secret: string): Promise<void> {
    checkAccount(account);
    if (!SECRET.test(secret)) throw new Error("A client token must be 16 to 128 URL-safe characters");
    await this.secrets.set(`${this.service}/${account}`, secret);
  }

  async delete(account: string): Promise<void> {
    checkAccount(account);
    await this.secrets.delete(`${this.service}/${account}`);
  }
}
