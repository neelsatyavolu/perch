/**
 * Keeps perchd's view of company policy current (Review Focus 2): it reads on first use (so start-up
 * waits for nothing), then every 30 seconds and whenever the managed-preferences folder changes,
 * and fires a "policy" event only when the resolved policy is different.
 */

import { watch as fsWatch, type FSWatcher } from "node:fs";
import { POLICY_NAMES } from "./catalogue";
import { cfPreferences } from "./cfprefs";
import { resolve, type Policy, type PolicyError, type PolicySource, type PolicyView } from "./policy";

export const MANAGED_PREFERENCES = "/Library/Managed Preferences";
const INTERVAL_MS = 30_000;

export type WatcherOptions = {
  source: PolicySource;
  intervalMs?: number;
  /** The folder to watch for changes; null watches nothing. */
  watchDir?: string | null;
  names?: readonly string[];
};

export class PolicyWatcher extends EventTarget implements PolicyView {
  private policy: Policy | null = null;
  private problems: PolicyError[] = [];
  private key = "";
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: FSWatcher | null = null;

  constructor(private readonly opts: WatcherOptions) {
    super();
  }

  current(): Policy {
    if (!this.policy) this.refresh();
    return this.policy!;
  }

  errors(): PolicyError[] {
    if (!this.policy) this.refresh();
    return this.problems;
  }

  /** Reads the source again; returns whether the policy changed. A failed read keeps the last policy. */
  refresh(): boolean {
    let next: ReturnType<typeof resolve>;
    try {
      next = resolve(this.opts.source.read(this.opts.names ?? POLICY_NAMES));
    } catch (error) {
      this.policy ??= {};
      this.problems = [{ name: "", message: `Perch could not read the managed settings: ${error instanceof Error ? error.message : String(error)}` }];
      return false;
    }
    const key = JSON.stringify([next.policy, next.errors]);
    const first = this.policy === null;
    this.policy = next.policy;
    this.problems = next.errors;
    if (key === this.key) return false;
    this.key = key;
    if (!first) this.dispatchEvent(new Event("policy"));
    return !first;
  }

  start(): this {
    this.timer ??= setInterval(() => this.refresh(), this.opts.intervalMs ?? INTERVAL_MS);
    this.timer.unref?.();
    const dir = this.opts.watchDir === undefined ? MANAGED_PREFERENCES : this.opts.watchDir;
    if (dir && !this.watcher) {
      try {
        this.watcher = fsWatch(dir, { recursive: true }, () => this.refresh());
        this.watcher.on("error", () => this.closeWatcher());
        this.watcher.unref?.();
      } catch {
        // No managed preferences folder (an unmanaged Mac): the 30-second check still runs.
      }
    }
    return this;
  }

  /** Calls `listener` with the new policy after every change; returns a function that stops it. */
  onChange(listener: (policy: Policy) => void): () => void {
    const handler = () => listener(this.current());
    this.addEventListener("policy", handler);
    return () => this.removeEventListener("policy", handler);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.closeWatcher();
  }

  private closeWatcher(): void {
    this.watcher?.close();
    this.watcher = null;
  }
}

/** perchd's watcher over the managed preferences for co.xanom.perch. */
export function startPolicyWatcher(): PolicyWatcher {
  return new PolicyWatcher({ source: cfPreferences() }).start();
}
