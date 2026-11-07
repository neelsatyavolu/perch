/**
 * The Memory page and Settings → Memory over the memory store and its API (src/memory): pages,
 * settings, the overnight tidy's log, and wiping. Building the profile is in profile.ts.
 */

import type { DreamLog, MemoryFolder, MemorySettings } from "../../../../ui-pages/src/api";
import { WIPE_CONFIRMATION } from "../../memory/api";
import type { Page } from "../../memory/page";
import type { Change } from "../../memory/store";
import type { PerchData } from "../../routines/service";
import { AppError } from "../runs";
import * as v from "../validate";
import { gone, notYet, ok, plainly, type Methods } from "./common";
import type { PagesDeps } from "./deps";
import { editedPage, pageBody, pageBytes } from "./memory-doc";

const FOLDERS: readonly MemoryFolder[] = ["users", "people", "companies", "sites", "projects", "routines", "concepts", "episodic"];
const MAX_BODY = 200_000;
const MAX_LOG_LINES = 20;
const CHANGES_READ = 2000;

function folderOf(path: string): MemoryFolder {
  const first = path.includes("/") ? path.split("/")[0]! : "";
  return (FOLDERS as readonly string[]).includes(first) ? (first as MemoryFolder) : "";
}

/** One overnight tidy per day, from the change log entries dreaming wrote. */
export function dreamLogs(changes: readonly Change[], limit: number): DreamLog[] {
  const byDay = new Map<string, Change[]>();
  for (const c of changes.filter((x) => x.source === "dreaming")) byDay.set(c.time.slice(0, 10), [...(byDay.get(c.time.slice(0, 10)) ?? []), c]);
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, limit)
    .map(([day, list]) => ({
      id: `dream-${day}`,
      at: list.map((c) => c.time).sort().at(-1)!,
      merged: list.filter((c) => c.action === "dream" && /merg/i.test(c.detail)).length,
      updated: list.filter((c) => c.action === "dream" && !/merg/i.test(c.detail)).length,
      archived: list.filter((c) => c.action === "delete").length,
      lines: list.map((c) => (c.action === "delete" ? `Archived ${c.detail || c.path}` : `${c.path}: ${c.detail}`)).slice(0, MAX_LOG_LINES),
    }));
}

export function memoryPages(deps: PagesDeps, onWipe: () => void): Methods<
  "getMemorySettings" | "setMemorySettings" | "listMemoryPages" | "readMemoryPage" | "writeMemoryPage" | "deleteMemoryPage" | "wipeMemory" | "listDreamLogs"
> {
  const data = () => deps.data();
  const now = () => (deps.now ?? (() => new Date()))().toISOString();

  async function page(d: PerchData, path: unknown): Promise<Page> {
    const clean = v.text(path, "path", 300);
    return d.memory.all().find((p) => p.path === clean) ?? gone("That memory page was deleted");
  }

  async function settings(): Promise<MemorySettings> {
    const d = await data();
    const s = d.memory.settings();
    const lastDream = (await d.memory.changes(CHANGES_READ)).find((c) => c.source === "dreaming")?.time;
    return { extraction: s.extraction && !s.paused, historyExtraction: false, dreaming: s.dreaming, ...(lastDream ? { lastDream } : {}) };
  }

  return {
    getMemorySettings: () => settings(),
    async setMemorySettings([rawPatch]) {
      const o = v.object(rawPatch, '"patch"');
      v.onlyKeys(o, ["extraction", "historyExtraction", "dreaming"]);
      const extraction = o.extraction === undefined ? undefined : v.bool(o.extraction, "extraction");
      const dreaming = o.dreaming === undefined ? undefined : v.bool(o.dreaming, "dreaming");
      if (o.historyExtraction !== undefined && v.bool(o.historyExtraction, "historyExtraction")) notYet("Perch can't learn from your browsing history yet.");
      const patch = { ...(extraction === undefined ? {} : { extraction, ...(extraction ? { paused: false } : {}) }), ...(dreaming === undefined ? {} : { dreaming }) };
      ok(await (await data()).memoryApi.updateSettings(patch));
      return settings();
    },
    async listMemoryPages() {
      return (await data()).memory.all()
        .map((p) => ({ path: p.path, title: p.title, folder: folderOf(p.path), updatedAt: p.updated, bytes: pageBytes(p) }))
        .sort((a, b) => (a.path < b.path ? -1 : 1));
    },
    async readMemoryPage([path]) {
      const p = await page(await data(), path);
      return { path: p.path, title: p.title, body: pageBody(p), updatedAt: p.updated };
    },
    async writeMemoryPage([path, body]) {
      const d = await data();
      const p = await page(d, path);
      const next = editedPage(p, v.text(body, "body", MAX_BODY), now());
      const saved = await plainly(() => d.memory.replacePage(next, { action: "edit", detail: "Edited on the Memory page", source: "user" }, p.updated));
      if (!saved) throw new AppError("The page changed while you edited it. Open it again to see the new version.", 409);
      return { path: saved.path, title: saved.title, body: pageBody(saved), updatedAt: saved.updated };
    },
    async deleteMemoryPage([path]) {
      const d = await data();
      await d.memory.deletePage((await page(d, path)).id);
    },
    async wipeMemory() {
      ok(await (await data()).memoryApi.wipe({ confirm: WIPE_CONFIRMATION }));
      onWipe();
    },
    async listDreamLogs([limit]) {
      const n = v.integer(limit, "limit", 0, 365);
      return dreamLogs(await (await data()).memory.changes(CHANGES_READ), n);
    },
  };
}
