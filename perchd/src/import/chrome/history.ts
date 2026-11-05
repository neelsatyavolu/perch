/** Chromium's `History` SQLite database: one entry per URL with its last visit. */

import type { Database } from "bun:sqlite";
import { withSqliteCopy } from "../sqlite-copy";
import { fromChromium } from "../time";
import type { HistoryEntry } from "../types";

const WEB = "(url LIKE 'http://%' OR url LIKE 'https://%')";

export function readChromeHistory(path: string): Promise<HistoryEntry[]> {
  return withSqliteCopy(path, (db) =>
    (
      db
        .query(`SELECT url, title, visit_count, typed_count, last_visit_time FROM urls WHERE hidden = 0 AND last_visit_time > 0 AND ${WEB} ORDER BY last_visit_time DESC`)
        .all() as { url: string; title: string | null; visit_count: number; typed_count: number; last_visit_time: number | bigint }[]
    ).flatMap((r) => {
      const lastVisit = fromChromium(r.last_visit_time);
      return lastVisit === undefined ? [] : [{ url: r.url, title: r.title ?? "", visitCount: Math.max(1, r.visit_count), typedCount: r.typed_count, lastVisit }];
    }),
  );
}

export function countChromeHistory(path: string): Promise<number> {
  return withSqliteCopy(path, (db: Database) => (db.query(`SELECT COUNT(*) AS n FROM urls WHERE hidden = 0 AND last_visit_time > 0 AND ${WEB}`).get() as { n: number }).n);
}
