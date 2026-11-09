/**
 * An extension's own data (its settings, scripts and sign-in), copied from the source profile so
 * a reinstalled extension starts the way it was left. Chromium keeps it per extension id in
 * leveldb folders, which are copied whole before the extension is installed in Perch. An
 * extension Perch already has keeps its own data. Nothing here fails an import.
 */

import { cpSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ID = /^[a-p]{32}$/;

/** Folders under a profile that belong to one extension. */
const folders = (id: string): readonly string[] => [
  join("Local Extension Settings", id),
  join("Sync Extension Settings", id),
  join("IndexedDB", `chrome-extension_${id}_0.indexeddb.leveldb`),
  join("IndexedDB", `chrome-extension_${id}_0.indexeddb.blob`),
];

/** Returns the ids whose data was copied. */
export function copyExtensionData(sourceProfile: string, targetProfile: string, ids: readonly string[]): string[] {
  const copied: string[] = [];
  for (const id of ids) {
    if (!ID.test(id) || existsSync(join(targetProfile, "Extensions", id))) continue;
    let any = false;
    for (const folder of folders(id)) {
      const from = join(sourceProfile, folder);
      const to = join(targetProfile, folder);
      if (!existsSync(from) || existsSync(to)) continue;
      try {
        mkdirSync(join(to, ".."), { recursive: true });
        // The source browser may be open and holding LOCK; leveldb makes its own.
        cpSync(from, to, { recursive: true, filter: (path) => !path.endsWith("/LOCK") });
        any = true;
      } catch {
        // Unreadable data is left behind; the extension still installs, empty.
      }
    }
    if (any) copied.push(id);
  }
  return copied;
}
