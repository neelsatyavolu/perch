/**
 * Where Perch keeps secrets (spec 11.1): the macOS Keychain. Values are stored base64-encoded so
 * `security -w` always prints them back verbatim, and writes go through `security -i` on stdin so
 * a secret never shows up in a process list. Tests use MemoryKeychain and never touch the real one.
 */

export interface SecretStore {
  get(account: string): Promise<string | null>;
  set(account: string, value: string): Promise<void>;
  delete(account: string): Promise<void>;
}

export type Runner = (args: string[], stdin?: string) => Promise<{ code: number; stdout: string; stderr: string }>;

/** Account names are built by Perch (like mcp/github/env/TOKEN); anything else is refused. */
const ACCOUNT = /^[A-Za-z0-9._@:/+-]{1,200}$/;
const SERVICE = /^[A-Za-z0-9 ._-]{1,64}$/;
/** `security` exits with 44 when an item does not exist. */
const NOT_FOUND = 44;

function checkAccount(account: string): void {
  if (!ACCOUNT.test(account)) throw new Error(`"${account.slice(0, 40)}" is not a valid Keychain account name`);
}

export class MemoryKeychain implements SecretStore {
  private items: ReadonlyMap<string, string> = new Map();

  async get(account: string): Promise<string | null> {
    return this.items.get(account) ?? null;
  }
  async set(account: string, value: string): Promise<void> {
    checkAccount(account);
    this.items = new Map([...this.items, [account, value]]);
  }
  async delete(account: string): Promise<void> {
    this.items = new Map([...this.items].filter(([k]) => k !== account));
  }
  /** Account names only, for tests that check where secrets went. */
  accounts(): string[] {
    return [...this.items.keys()];
  }
}

const runSecurity: Runner = async (args, stdin) => {
  const proc = Bun.spawn(["/usr/bin/security", ...args], { stdin: stdin === undefined ? "ignore" : "pipe", stdout: "pipe", stderr: "pipe" });
  if (stdin !== undefined && proc.stdin) {
    proc.stdin.write(stdin);
    await proc.stdin.end();
  }
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
};

export class MacKeychain implements SecretStore {
  private readonly service: string;
  private readonly run: Runner;

  constructor(opts: { service?: string; run?: Runner } = {}) {
    this.service = opts.service ?? "Perch";
    if (!SERVICE.test(this.service)) throw new Error("not a valid Keychain service name");
    this.run = opts.run ?? runSecurity;
  }

  async get(account: string): Promise<string | null> {
    checkAccount(account);
    const r = await this.run(["find-generic-password", "-s", this.service, "-a", account, "-w"]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`Keychain read failed (security exited ${r.code})`);
    return Buffer.from(r.stdout.trim(), "base64").toString("utf8");
  }

  async set(account: string, value: string): Promise<void> {
    checkAccount(account);
    const hex = Buffer.from(Buffer.from(value, "utf8").toString("base64"), "utf8").toString("hex");
    const r = await this.run(["-i"], `add-generic-password -U -s "${this.service}" -a "${account}" -X ${hex}\n`);
    // security -i reports command errors on stderr but can still exit 0.
    if (r.code !== 0 || /error|fail/i.test(r.stderr)) throw new Error(`Keychain write failed (security exited ${r.code})`);
  }

  async delete(account: string): Promise<void> {
    checkAccount(account);
    const r = await this.run(["delete-generic-password", "-s", this.service, "-a", account]);
    if (r.code !== 0 && r.code !== NOT_FOUND) throw new Error(`Keychain delete failed (security exited ${r.code})`);
  }
}
