/**
 * The ZIP Safari makes with File > Export Browsing Data to File (Safari 18 and later). It holds
 * Bookmarks.html, History.json and Passwords.csv (each only if the user ticked it). Reading it
 * needs no Full Disk Access, which makes it the easy path for Safari.
 */

import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBookmarksHtml } from "../files/bookmarks-html";
import { parsePasswordsCsv } from "../files/passwords-csv";
import { fromUnixMicros } from "../time";
import { ImportError, isWebUrl, type HistoryEntry, type ImportData } from "../types";

const MAX_ZIP = 512 * 1024 * 1024;

/** Files at the top of the export or one folder down (Safari profiles get their own names). */
function findFiles(dir: string, depth = 0): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const st = lstatSync(path); // never follow a symlink packed in the ZIP
    if (st.isDirectory()) return depth < 1 ? findFiles(path, depth + 1) : [];
    return st.isFile() ? [path] : [];
  });
}

export function parseSafariHistoryJson(text: string): HistoryEntry[] {
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ImportError("History.json in the Safari export could not be read.", "unreadable");
  }
  const items: any[] = Array.isArray(json?.history) ? json.history : [];
  return items.flatMap((h): HistoryEntry[] => {
    const lastVisit = fromUnixMicros(Number(h?.time_usec));
    const url = typeof h?.url === "string" ? h.url : "";
    if (!lastVisit || !isWebUrl(url)) return [];
    return [{ url, title: typeof h.title === "string" ? h.title : "", visitCount: Math.max(1, Number(h.visit_count) || 1), typedCount: 0, lastVisit }];
  });
}

export async function readSafariExport(zipPath: string): Promise<ImportData & { readonly skipped: number }> {
  if (!/\.zip$/i.test(zipPath)) throw new ImportError("Choose the ZIP file Safari made with File > Export Browsing Data to File.", "invalid");
  let size: number;
  try {
    size = statSync(zipPath).size;
  } catch {
    throw new ImportError("That ZIP file could not be opened.", "not-found");
  }
  if (size > MAX_ZIP) throw new ImportError("That ZIP file is larger than a Safari export can be.", "invalid");
  const dir = mkdtempSync(join(tmpdir(), "perch-safari-export-"));
  chmodSync(dir, 0o700);
  try {
    // unzip refuses entries with "../" or absolute paths, so nothing lands outside `dir`.
    const proc = Bun.spawn(["/usr/bin/unzip", "-qq", "-o", zipPath, "-d", dir], { stdout: "ignore", stderr: "ignore" });
    if ((await proc.exited) > 1) throw new ImportError("That ZIP file could not be read.", "unreadable");
    const files = findFiles(dir);
    const named = (re: RegExp) => files.filter((f) => re.test(f.split("/").pop() ?? ""));
    const bookmarks = named(/^Bookmarks.*\.html$/i)[0];
    const history = named(/^History.*\.json$/i);
    const passwords = named(/^Passwords.*\.csv$/i)[0];
    const csv = passwords ? parsePasswordsCsv(readFileSync(passwords, "utf8")) : undefined;
    return {
      ...(bookmarks ? { bookmarks: parseBookmarksHtml(readFileSync(bookmarks, "utf8")) } : {}),
      ...(history.length ? { history: history.flatMap((h) => parseSafariHistoryJson(readFileSync(h, "utf8"))) } : {}),
      ...(csv ? { passwords: csv.passwords } : {}),
      skipped: csv?.skipped ?? 0,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
