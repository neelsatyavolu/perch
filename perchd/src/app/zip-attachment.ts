/**
 * An attached .zip, opened so the agent can read it like an attached folder: its files are unpacked
 * once into a folder only this user can read, removed when perchd quits. Entries that would land
 * outside that folder are skipped, and archives that unpack too big are refused.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import { unzipSync } from "fflate";

const MAX_ZIP = 200 * 1024 * 1024;
const MAX_UNPACKED = 500 * 1024 * 1024;
const MAX_ENTRIES = 5000;

export const isZip = (path: string) => /\.zip$/i.test(path);

let root: string | null = null;
const opened = new Map<string, Promise<string>>();

function unpackRoot(): string {
  if (!root) {
    root = mkdtempSync(join(tmpdir(), "perch-unzipped-"));
    chmodSync(root, 0o700);
    const dir = root;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return root;
}

/** A path inside the archive that stays inside it: no absolute paths, no "..". */
function safeEntry(name: string): string | null {
  if (name.endsWith("/") || name.startsWith("/") || name.includes("\\") || name.startsWith("__MACOSX/")) return null;
  const clean = normalize(name);
  return clean.startsWith("..") || clean.split("/").includes("..") ? null : clean;
}

async function unpack(zip: string): Promise<string> {
  if ((await stat(zip)).size > MAX_ZIP) throw new Error("That zip is over 200 MB, too big to open.");
  let total = 0;
  let count = 0;
  const entries = unzipSync(new Uint8Array(await readFile(zip)), {
    filter: (f) => {
      if (!safeEntry(f.name)) return false;
      total += f.originalSize;
      count += 1;
      if (total > MAX_UNPACKED || count > MAX_ENTRIES) throw new Error("That zip unpacks to more than 500 MB or 5,000 files, too big to open.");
      return true;
    },
  });
  const dir = mkdtempSync(join(unpackRoot(), "z-"));
  for (const [name, bytes] of Object.entries(entries)) {
    const path = join(dir, safeEntry(name)!);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, bytes, { mode: 0o600 });
  }
  return dir;
}

/** The folder an attached zip unpacks to; opened once per launch. */
export function openZip(zip: string): Promise<string> {
  const known = opened.get(zip);
  if (known) return known;
  const next = unpack(zip);
  opened.set(zip, next);
  next.catch(() => opened.delete(zip));
  return next;
}
