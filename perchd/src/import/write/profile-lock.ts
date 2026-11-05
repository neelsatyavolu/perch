/**
 * Chromium marks a running user data dir with a `SingletonLock` symlink whose target is
 * "<hostname>-<pid>". Files in the profile are only written while no live process holds it.
 */

import { readlinkSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

export function profileInUse(userDataDir: string): boolean {
  let target: string;
  try {
    target = readlinkSync(join(userDataDir, "SingletonLock"));
  } catch {
    return false;
  }
  const dash = target.lastIndexOf("-");
  const host = target.slice(0, dash);
  const pid = Number(target.slice(dash + 1));
  // A lock from another machine (a synced or copied folder) cannot be checked; treat it as held.
  if (host !== hostname()) return true;
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
