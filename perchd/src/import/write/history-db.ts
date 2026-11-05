/**
 * Add imported history to a Perch profile's `History` database while Perch is closed. Only a
 * database Chromium itself created is written (its schema and version must be Chromium's own),
 * so a profile that has never been opened gets its history from the bundle instead.
 *
 * Like Chrome's importer, each URL gets one visit at its last visit time. A URL already present
 * keeps its row; counts and times only grow, so a second import adds nothing.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { hasTable } from "../sqlite-copy";
import { toChromium } from "../time";
import { ImportError, isWebUrl, type HistoryEntry } from "../types";

/** PAGE_TRANSITION_LINK with CHAIN_START and CHAIN_END, what Chrome uses for imported visits. */
const IMPORTED_TRANSITION = 0x30000000;
const MAX_URL = 2 * 1024 * 1024;

export function addHistory(path: string, entries: readonly HistoryEntry[]): number {
  if (!existsSync(path)) throw new ImportError("Perch's History database does not exist yet. Open Perch once, quit it, and import again.", "not-found");
  const db = new Database(path);
  const statements: { finalize(): void }[] = [];
  const prepare = (sql: string) => {
    const statement = db.prepare(sql);
    statements.push(statement);
    return statement;
  };
  try {
    if (!hasTable(db, "urls") || !hasTable(db, "visits")) throw new ImportError("Perch's History database is not in the expected format.", "unreadable");
    const find = prepare("SELECT id, title, visit_count, typed_count, last_visit_time FROM urls WHERE url = ? LIMIT 1");
    const insertUrl = prepare("INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, ?, ?, 0)");
    const updateUrl = prepare("UPDATE urls SET title = ?, visit_count = ?, typed_count = ?, last_visit_time = ? WHERE id = ?");
    const hasVisit = prepare("SELECT 1 FROM visits WHERE url = ? AND visit_time = ? LIMIT 1");
    const insertVisit = prepare("INSERT INTO visits (url, visit_time, from_visit, transition, segment_id) VALUES (?, ?, 0, ?, 0)");
    let added = 0;
    db.transaction(() => {
      for (const e of entries) {
        if (!isWebUrl(e.url) || e.url.length > MAX_URL || !Number.isFinite(e.lastVisit)) continue;
        const time = Number(toChromium(e.lastVisit));
        const row = find.get(e.url) as { id: number; title: string | null; visit_count: number; typed_count: number; last_visit_time: number } | null;
        let urlId: number;
        if (row) {
          urlId = row.id;
          updateUrl.run(row.title || e.title, Math.max(row.visit_count, e.visitCount), Math.max(row.typed_count, e.typedCount), Math.max(row.last_visit_time, time), urlId);
        } else {
          urlId = Number(insertUrl.run(e.url, e.title, Math.max(1, e.visitCount), Math.max(0, e.typedCount), time).lastInsertRowid);
        }
        if (hasVisit.get(urlId, time)) continue;
        insertVisit.run(urlId, time, IMPORTED_TRANSITION);
        added++;
      }
    })();
    return added;
  } finally {
    // Chromium may keep History in WAL mode with exclusive locking; leave no WAL frames behind.
    // A failed checkpoint must not hide the error that got us here, and the data is committed.
    try {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      // The rows are committed; Chromium replays any WAL frames itself on open.
    }
    // Open statements keep the connection (and its locks) alive past close(); Chrome then
    // fails to load History and shows an empty list. Finalize them first.
    for (const statement of statements) statement.finalize();
    db.close();
  }
}
