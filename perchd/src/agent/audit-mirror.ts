/**
 * The company's copy of the audit log (AuditLogPath, spec 12.2; Review Focus 4). Each entry the
 * local log gets is appended here as the same JSON line, nothing more. The path may start with
 * `~/` and contain `${USER}`. A missing folder is made 0700 and the file 0600. When a log
 * collector rotates the file by renaming it, the next entry starts a new file at the path. A write
 * that fails is recorded for perch://policy and Settings; the local log is unaffected, and the
 * mirror tries again after a minute.
 */

import { closeSync, fstatSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute } from "node:path";
import type { AuditEntry, AuditSink } from "./audit";
import type { PolicyView } from "../policy/policy";

const RETRY_MS = 60_000;

export type MirrorOptions = { home?: string; user?: string; now?: () => number; retryMs?: number };

/** AuditLogPath with `~/` and `${USER}` filled in; null when it is not absolute after that. */
export function expandAuditPath(raw: string, home = homedir(), user = userInfo().username): string | null {
  const withUser = raw.replaceAll("${USER}", user);
  const path = withUser.startsWith("~/") ? `${home}/${withUser.slice(2)}` : withUser;
  return isAbsolute(path) && !path.split("/").includes("..") ? path : null;
}

export class AuditMirror implements AuditSink {
  readonly path: string | null;
  private fd: number | null = null;
  private inode: number | null = null;
  private problem: string | null = null;
  private retryAt = 0;

  constructor(readonly raw: string, private readonly opts: MirrorOptions = {}) {
    this.path = expandAuditPath(raw, opts.home, opts.user);
    if (!this.path) this.problem = `AuditLogPath "${raw}" is not an absolute path or one starting with ~/`;
  }

  /** The last write error, or null while writes succeed. */
  error(): string | null {
    return this.problem;
  }

  write(entry: AuditEntry): void {
    if (!this.path) return;
    const now = (this.opts.now ?? Date.now)();
    if (this.problem && now < this.retryAt) return;
    try {
      const fd = this.handle(this.path);
      writeSync(fd, `${JSON.stringify(entry)}\n`);
      this.problem = null;
    } catch (error) {
      this.close();
      this.problem = `Perch couldn't write the audit log copy to ${this.path}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
      this.retryAt = now + (this.opts.retryMs ?? RETRY_MS);
    }
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.inode = null;
  }

  /** The open file for the path, reopened when the file at the path is no longer the one open. */
  private handle(path: string): number {
    if (this.fd !== null && this.inode !== null && currentInode(path) === this.inode) return this.fd;
    this.close();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(path, "a", 0o600);
    this.fd = fd;
    this.inode = fstatSync(fd).ino;
    return fd;
  }
}

function currentInode(path: string): number | null {
  try {
    return statSync(path).ino;
  } catch {
    return null;
  }
}

/** The mirror that follows the policy: none without AuditLogPath, a new one when the path changes. */
export class PolicyAuditMirror implements AuditSink {
  private mirror: AuditMirror | null = null;

  constructor(private readonly policy: PolicyView, private readonly opts: MirrorOptions = {}) {}

  write(entry: AuditEntry): void {
    this.current()?.write(entry);
  }

  /** The mirror's problem, for getPolicy().errors; null when it writes or there is none. */
  error(): string | null {
    return this.current()?.error() ?? null;
  }

  private current(): AuditMirror | null {
    const raw = this.policy.current().AuditLogPath;
    if (raw === undefined) {
      this.mirror?.close();
      this.mirror = null;
    } else if (this.mirror?.raw !== raw) {
      this.mirror?.close();
      this.mirror = new AuditMirror(raw, this.opts);
    }
    return this.mirror;
  }
}
