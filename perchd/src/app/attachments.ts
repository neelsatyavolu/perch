/**
 * Files the user attached (plan 3b task 13). The browser shows the open panel, then registers the
 * paths the user picked here with its own token (`POST /api/files`) and hands the page opaque ids.
 * Pages never see or name a path; a message refers to its files by id, and only the task text
 * given to the agent carries the paths, since the user chose to share those files.
 *
 * Ids live for this launch only.
 */

import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, isAbsolute, join, normalize } from "node:path";
import { AppError } from "./runs";

export type AttachedFile = { id: string; name: string; size: number };
type Entry = AttachedFile & { path: string };

const MAX_FILES = 1000;
const MAX_PER_CALL = 20;
/** A pasted or dropped file: the chat's request limit leaves room for about 8 MB once encoded. */
export const MAX_PASTED = 8 * 1024 * 1024;
const MAX_PREVIEW = 10 * 1024 * 1024;
const IMAGE_TYPES: Readonly<Record<string, string>> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

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

  /**
   * A file pasted or dropped into the chat: its bytes are written to a folder only this user can
   * read, removed when perchd quits, and registered like a file picked in the open panel.
   */
  store(name: string, bytes: Uint8Array): AttachedFile {
    if (bytes.length === 0) throw new AppError("That file is empty");
    if (bytes.length > MAX_PASTED) throw new AppError("Paste files up to 8 MB; attach bigger ones with +");
    const clean = basename(name).replace(/[^\p{L}\p{N} ._()-]/gu, "_").slice(0, 120) || "pasted";
    const dir = mkdtempSync(join(this.pastedRoot(), "f-"));
    const path = join(dir, clean);
    writeFileSync(path, bytes, { mode: 0o600 });
    return this.register([path])[0]!;
  }

  /** An attached image's bytes and type, for its thumbnail; null for other files. */
  preview(id: string): { bytes: Uint8Array; type: string } | null {
    const entry = this.resolve(id);
    const type = IMAGE_TYPES[extname(entry.name).toLowerCase()];
    if (!type || entry.size > MAX_PREVIEW) return null;
    try {
      return { bytes: readFileSync(entry.path), type };
    } catch {
      return null;
    }
  }

  private pasted: string | null = null;

  private pastedRoot(): string {
    if (!this.pasted) {
      this.pasted = mkdtempSync(join(tmpdir(), "perch-pasted-"));
      chmodSync(this.pasted, 0o700);
      const root = this.pasted;
      process.once("exit", () => rmSync(root, { recursive: true, force: true }));
    }
    return this.pasted;
  }

  /** A registered file, with its path, for the task text. */
  resolve(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new AppError("That attachment is no longer available. Attach the file again", 404);
    return entry;
  }
}
