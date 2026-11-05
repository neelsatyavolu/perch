/** The audit log: one JSON line per agent action, readable only by the owner (spec 7.4). */

import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type AuditEntry = {
  time: string;
  tab: string;
  site: string;
  action: string;
  detail?: string;
  client: string;
  /** true or false when the user was asked; null when no approval was needed. */
  approved: boolean | null;
  result: "ok" | "error" | "blocked" | "declined";
};

export class AuditLog {
  private ready: Promise<void> | null = null;

  constructor(readonly path: string) {}

  async append(entry: AuditEntry): Promise<void> {
    this.ready ??= mkdir(dirname(this.path), { recursive: true, mode: 0o700 }).then(() => undefined);
    await this.ready;
    await appendFile(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    await chmod(this.path, 0o600);
  }
}
