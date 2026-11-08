/**
 * Files the user attached (plan 3b task 13). The browser shows the open panel, then registers the
 * paths the user picked here with its own token (`POST /api/files`) and hands the page opaque ids.
 * Pages never see or name a path; a message refers to its files by id, and only the task text
 * given to the agent carries the paths, since the user chose to share those files.
 *
 * Ids live for this launch only.
 */

import { statSync } from "node:fs";
import { basename, isAbsolute, normalize } from "node:path";
import { AppError } from "./runs";

export type AttachedFile = { id: string; name: string; size: number };
type Entry = AttachedFile & { path: string };

const MAX_FILES = 1000;
const MAX_PER_CALL = 20;

export class FileRegistry {
  private entries = new Map<string, Entry>();

  /** Registers files the user picked in the browser's open panel. */
  register(paths: readonly string[]): AttachedFile[] {
    if (paths.length > MAX_PER_CALL) throw new AppError(`Attach up to ${MAX_PER_CALL} files at a time`);
    const added = paths.map((raw) => {
      if (typeof raw !== "string" || !isAbsolute(raw) || normalize(raw) !== raw) throw new AppError("Each file must be an absolute path");
      let size: number;
      try {
        const stat = statSync(raw);
        if (!stat.isFile()) throw new Error("not a file");
        size = stat.size;
      } catch {
        throw new AppError(`${basename(raw)} isn't a file Perch can read`);
      }
      return { id: crypto.randomUUID(), name: basename(raw), size, path: raw };
    });
    const next = new Map(this.entries);
    for (const e of added) next.set(e.id, e);
    // The oldest go first once there are too many.
    while (next.size > MAX_FILES) next.delete(next.keys().next().value!);
    this.entries = next;
    return added.map(({ path: _, ...file }) => file);
  }

  /** A registered file, with its path, for the task text. */
  resolve(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError("That attachment is no longer available. Attach the file again", 404);
    return entry;
  }
}
