/**
 * Outside clients (spec 7.4, 11.1): each has a token in the Keychain and a record here with its
 * permission mode. The record file holds no secrets. First use registers a client in Guard
 * (the socket is already limited to this user); a revoked client stays out until allowed again.
 *
 * perchd reads the file once and keeps the records in memory, so editing the file while it runs
 * changes nothing. The file is sealed with a key kept in the Keychain: a file whose seal does not
 * match (edited by hand or by another program) loads with every mode above Guard lowered to Guard.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "../agent/permissions";
import { ManagedError } from "../policy/policy";
import { CLIENT_NAME, type Keychain } from "./keychain";

export type ClientRecord = { name: string; mode: Mode; created: string; lastUsed?: string; revoked?: boolean };
export type Verified = ClientRecord | { error: string };

const MODES: readonly Mode[] = ["ask", "guard", "skip"];
const REJECTED = "Perch did not accept this client's token.";
export const BAD_NAME = 'Client names use lowercase letters, digits and dashes, like "claude-code".';
/** The Keychain account holding the key that seals clients.json (in its own service). */
const SEAL_ACCOUNT = "registry";

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}

/** Whether `next` lets a client do more without asking than `current`. */
export function raisesMode(current: Mode, next: Mode): boolean {
  return MODES.indexOf(next) > MODES.indexOf(current);
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readRecords(file: string): { clients: ClientRecord[]; seal?: string } {
  if (!existsSync(file)) return { clients: [] };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { clients?: ClientRecord[]; seal?: unknown };
    const clients = (Array.isArray(data.clients) ? data.clients : []).filter((c) => CLIENT_NAME.test(c?.name) && isMode(c.mode));
    return { clients, seal: typeof data.seal === "string" ? data.seal : undefined };
  } catch {
    return { clients: [] };
  }
}

/** The client names in the clients file, for moving their tokens out of the Keychain (plan 3b). */
export function readRecordNames(file: string): string[] {
  return readRecords(file).clients.map((c) => c.name);
}

export class ClientRegistry {
  private records: ClientRecord[] | null = null;
  private key: string | null = null;

  /**
   * `sealKeychain` holds the file's seal key; perchd passes one, the CLI does not need it.
   * `maxMode` is the company's cap (spec 12.2): no client can be set above it.
   */
  constructor(
    readonly file: string,
    private readonly keychain: Keychain,
    private readonly sealKeychain?: Keychain,
    private readonly maxMode: () => Mode | undefined = () => undefined,
  ) {}

  /** perchd's start: reads the file once and checks its seal. */
  async load(): Promise<void> {
    const { clients, seal } = readRecords(this.file);
    if (!this.sealKeychain || !clients.length) {
      this.records = clients;
      return;
    }
    const expected = this.sign(await this.sealKey(), clients);
    const trusted = seal !== undefined && sameToken(seal, expected);
    this.records = trusted ? clients : clients.map((c) => (raisesMode("guard", c.mode) ? { ...c, mode: "guard" as Mode } : c));
  }

  list(): ClientRecord[] {
    return this.records ?? readRecords(this.file).clients;
  }

  /** The client side: this client's token, made and saved in the Keychain on first use. */
  async token(name: string): Promise<string> {
    if (!CLIENT_NAME.test(name)) throw new Error(BAD_NAME);
    const saved = await this.keychain.get(name);
    if (saved) return saved;
    const token = newToken();
    await this.keychain.set(name, token);
    return token;
  }

  /** The daemon side: checks a client's token and returns its record. */
  async verify(name: string, token: string): Promise<Verified> {
    if (!CLIENT_NAME.test(name)) return { error: BAD_NAME };
    const record = this.list().find((c) => c.name === name);
    if (record?.revoked) return { error: `Client "${name}" was revoked. Run: perch clients allow ${name}` };
    const saved = await this.keychain.get(name);
    if (!saved || typeof token !== "string" || !sameToken(saved, token)) return { error: REJECTED };
    const now = new Date().toISOString();
    const next: ClientRecord = record ? { ...record, lastUsed: now } : { name, mode: "guard", created: now, lastUsed: now };
    await this.upsert(next);
    return next;
  }

  async revoke(name: string): Promise<void> {
    if (!CLIENT_NAME.test(name)) throw new Error(BAD_NAME);
    await this.keychain.delete(name);
    const record = this.list().find((c) => c.name === name);
    await this.upsert({ ...(record ?? { name, mode: "guard" as Mode, created: new Date().toISOString() }), revoked: true });
  }

  async allow(name: string): Promise<void> {
    const { revoked: _, ...rest } = this.find(name);
    await this.upsert(rest);
  }

  async setMode(name: string, mode: Mode): Promise<void> {
    if (!isMode(mode)) throw new Error("The mode must be ask, guard or skip");
    const max = this.maxMode();
    if (max && raisesMode(max, mode)) throw new ManagedError(`Your organization allows outside agents up to ${max} mode.`);
    await this.upsert({ ...this.find(name), mode });
  }

  find(name: string): ClientRecord {
    const record = this.list().find((c) => c.name === name);
    if (!record) throw new Error(`No client named "${name}"`);
    return record;
  }

  private async sealKey(): Promise<string> {
    if (this.key) return this.key;
    const keychain = this.sealKeychain!;
    const saved = await keychain.get(SEAL_ACCOUNT);
    if (saved) return (this.key = saved);
    const key = newToken();
    await keychain.set(SEAL_ACCOUNT, key);
    return (this.key = key);
  }

  private sign(key: string, clients: ClientRecord[]): string {
    return createHmac("sha256", key).update(JSON.stringify(clients)).digest("base64url");
  }

  private async upsert(record: ClientRecord): Promise<void> {
    const clients = [...this.list().filter((c) => c.name !== record.name), record].sort((a, b) => a.name.localeCompare(b.name));
    const seal = this.sealKeychain ? this.sign(await this.sealKey(), clients) : undefined;
    this.records = clients;
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, clients, ...(seal ? { seal } : {}) }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
