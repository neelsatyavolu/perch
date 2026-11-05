/**
 * Outside clients (spec 7.4, 11.1): each has a token in the Keychain and a record here with its
 * permission mode. The record file holds no secrets. First use registers a client in Guard
 * (the socket is already limited to this user); a revoked client stays out until allowed again.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Mode } from "../agent/permissions";
import { CLIENT_NAME, type Keychain } from "./keychain";

export type ClientRecord = { name: string; mode: Mode; created: string; lastUsed?: string; revoked?: boolean };
export type Verified = ClientRecord | { error: string };

const MODES: readonly Mode[] = ["ask", "guard", "skip"];
const REJECTED = "Perch did not accept this client's token.";
export const BAD_NAME = 'Client names use lowercase letters, digits and dashes, like "claude-code".';

export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function isMode(value: unknown): value is Mode {
  return MODES.includes(value as Mode);
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class ClientRegistry {
  constructor(readonly file: string, private readonly keychain: Keychain) {}

  list(): ClientRecord[] {
    if (!existsSync(this.file)) return [];
    try {
      const data = JSON.parse(readFileSync(this.file, "utf8")) as { clients?: ClientRecord[] };
      return (data.clients ?? []).filter((c) => CLIENT_NAME.test(c.name) && isMode(c.mode));
    } catch {
      return [];
    }
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
    this.upsert(next);
    return next;
  }

  async revoke(name: string): Promise<void> {
    if (!CLIENT_NAME.test(name)) throw new Error(BAD_NAME);
    await this.keychain.delete(name);
    const record = this.list().find((c) => c.name === name);
    this.upsert({ ...(record ?? { name, mode: "guard" as Mode, created: new Date().toISOString() }), revoked: true });
  }

  allow(name: string): void {
    const record = this.list().find((c) => c.name === name);
    if (!record) throw new Error(`No client named "${name}"`);
    const { revoked: _, ...rest } = record;
    this.upsert(rest);
  }

  setMode(name: string, mode: Mode): void {
    if (!isMode(mode)) throw new Error("The mode must be ask, guard or skip");
    const record = this.list().find((c) => c.name === name);
    if (!record) throw new Error(`No client named "${name}"`);
    this.upsert({ ...record, mode });
  }

  private upsert(record: ClientRecord): void {
    const clients = [...this.list().filter((c) => c.name !== record.name), record].sort((a, b) => a.name.localeCompare(b.name));
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, `${JSON.stringify({ version: 1, clients }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.file);
  }
}
