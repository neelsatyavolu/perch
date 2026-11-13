/**
 * Chat folders (perch-chat-*, tools.ts) and outside-agent folders (perch-exec-*, external.ts) are
 * removed when their chat or task ends. A perchd that crashed or was killed leaves them behind,
 * with downloaded documents and files the agent wrote, so perchd clears old ones when it starts.
 */

import { readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIXES = ["perch-chat-", "perch-exec-"];
/** Old enough that no running chat still uses it: a day without a change. */
const STALE_MS = 24 * 60 * 60_000;

/** Removes stale Perch work folders in `root`; returns how many went. Never throws. */
export function removeStaleWorkFolders(root = tmpdir(), now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return 0;
  }
  for (const name of names.filter((n) => PREFIXES.some((p) => n.startsWith(p)))) {
    const path = join(root, name);
    try {
      const stat = statSync(path);
      if (!stat.isDirectory() || now - stat.mtimeMs < STALE_MS) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch {
      // Gone already, or not ours to remove: either way, nothing to do.
    }
  }
  return removed;
}
