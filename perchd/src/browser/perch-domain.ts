/**
 * Typed calls to the `Perch` CDP domain (plan 3b). Perch's browser answers these for perchd, its
 * trusted pipe client, only. A method the running browser does not have yet (an older build, or
 * Chrome for Testing in development) answers -32601; the wrapper then returns null, remembers it
 * and stops asking, so every caller has a plain fallback instead of an error.
 *
 * Nothing here ever carries a secret: fill methods return outcomes, and listings name ids only.
 */

import { CdpError, type CdpConnection } from "../cdp/connection";

const METHOD_NOT_FOUND = -32601;

export type TaskStatus = "idle" | "running" | "waiting";

export type BookmarkNode = { id: string; title: string; url?: string; dateAdded?: number; children?: BookmarkNode[] };
export type BookmarkChange =
  | { op: "add"; parentId: string; title: string; url?: string; index?: number }
  | { op: "update"; id: string; title?: string; url?: string }
  | { op: "move"; id: string; parentId: string; index?: number }
  | { op: "remove"; id: string };
export type HistoryVisit = { url: string; title: string; time: number };
export type OpenTab = { tabId: string; url: string; title: string; pinned: boolean; groupId?: string };
export type OpenWindow = { windowId: string; incognito: boolean; tabs: OpenTab[]; groups: { groupId: string; title: string; color: string }[]; splits: [string, string][] };
export type ImportApplied = { bookmarks: number; history: number; passwords: number; cookies: number; tabs: number; searchEngines: number };
export type AskRequest = { text: string; tabId?: string; profile?: string };

/** The domain's calls. Each returns null when this browser lacks the method. */
export type PerchDomainApi = {
  setTaskStatus(p: { chatId: string; status: TaskStatus; targetIds: string[]; title?: string }): Promise<{} | null>;
  revealChat(p: { chatId: string; tabId?: string; mode: "side" | "full" }): Promise<{} | null>;
  getBookmarks(): Promise<{ roots: BookmarkNode[] } | null>;
  applyBookmarkChanges(p: { changes: BookmarkChange[] }): Promise<{ applied: number; idMap?: Record<number, string> } | null>;
  getHistory(p: { since: number; max?: number }): Promise<{ visits: HistoryVisit[] } | null>;
  getOpenTabs(): Promise<{ windows: OpenWindow[] } | null>;
  applyImportBundle(p: { path: string }): Promise<{ applied: ImportApplied; skipped: string[] } | null>;
  /** The address bar's ⌘↵ and the new tab page's Ask. Returns a function that stops listening. */
  onAskRequested(listener: (ask: AskRequest) => void): () => void;
};

export class PerchDomain implements PerchDomainApi {
  private readonly missing = new Set<string>();

  constructor(private readonly conn: Pick<CdpConnection, "send" | "on">) {}

  /** Whether the browser has answered this method before (false once it said it has none). */
  has(method: string): boolean {
    return !this.missing.has(method);
  }

  async call<T>(method: string, params: object = {}): Promise<T | null> {
    if (this.missing.has(method)) return null;
    try {
      return await this.conn.send<T>(`Perch.${method}`, params);
    } catch (error) {
      if (error instanceof CdpError && (error.code === METHOD_NOT_FOUND || /wasn't found|not implemented/i.test(error.message))) {
        this.missing.add(method);
        return null;
      }
      throw error;
    }
  }

  setTaskStatus(p: { chatId: string; status: TaskStatus; targetIds: string[]; title?: string }) {
    return this.call<{}>("setTaskStatus", p);
  }

  revealChat(p: { chatId: string; tabId?: string; mode: "side" | "full" }) {
    return this.call<{}>("revealChat", p);
  }

  getBookmarks() {
    return this.call<{ roots: BookmarkNode[] }>("getBookmarks");
  }

  applyBookmarkChanges(p: { changes: BookmarkChange[] }) {
    return this.call<{ applied: number; idMap?: Record<number, string> }>("applyBookmarkChanges", p);
  }

  getHistory(p: { since: number; max?: number }) {
    return this.call<{ visits: HistoryVisit[] }>("getHistory", p);
  }

  getOpenTabs() {
    return this.call<{ windows: OpenWindow[] }>("getOpenTabs");
  }

  applyImportBundle(p: { path: string }) {
    return this.call<{ applied: ImportApplied; skipped: string[] }>("applyImportBundle", p);
  }

  onAskRequested(listener: (ask: AskRequest) => void): () => void {
    return this.conn.on("Perch.askRequested", (p: Record<string, unknown>) => {
      if (typeof p?.text !== "string" || !p.text.trim()) return;
      listener({
        text: p.text.slice(0, 50_000),
        ...(typeof p.tabId === "string" && p.tabId ? { tabId: p.tabId } : {}),
        ...(typeof p.profile === "string" ? { profile: p.profile } : {}),
      });
    });
  }
}
