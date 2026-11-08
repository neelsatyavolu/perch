/**
 * Typed calls to the `Perch` CDP domain (plan 3b). Perch's browser answers these for perchd, its
 * trusted pipe client, only. A method the running browser does not have yet (an older build, or
 * Chrome for Testing in development) answers -32601; the wrapper then returns null, remembers it
 * and stops asking, so every caller has a plain fallback instead of an error.
 *
 * Nothing here ever carries a secret: fill methods return outcomes, and listings name ids only.
 * The fill calls (task 7) fill logins, cards and one-time codes; listings carry ids, usernames,
 * the network and last four digits, for the approval card only, never a model message.
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
  /** Visits other devices made (sync); the browser adds them as synced visits. */
  addHistory(p: { visits: HistoryVisit[] }): Promise<{ added: number } | null>;
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

  addHistory(p: { visits: HistoryVisit[] }) {
    return this.call<{ added: number }>("addHistory", p);
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

/** The Perch component extension's fixed id (overlay perch_component_extensions.h). */
export const PERCH_EXTENSION_ID = "ocjanjehckpdbcjamffmbeemoooamjpo";

export type SavedLogin = { loginId: string; username: string; origin: string };
export type SavedCard = { cardId: string; network: string; lastFour: string; expiry: string };
export type FillOutcome = "filled" | "no-form" | "needs-user" | "failed";
/** What the browser filled: the outcome, and the fields' backend node ids in the tab's main frame, so their values are hidden from snapshots. */
export type FillResult = { result: FillOutcome; fields: number[] };
export type CodeOutcome = "filled" | "no-code" | "no-field";

const OUTCOMES = new Set<FillOutcome>(["filled", "no-form", "needs-user", "failed"]);
const CODE_OUTCOMES = new Set<CodeOutcome>(["filled", "no-code", "no-field"]);

const text = (v: unknown, max = 512): string | null => (typeof v === "string" && v.length <= max ? v : null);

function fillResult(raw: unknown): FillResult {
  const r = raw as { result?: unknown; fields?: unknown } | null;
  const result = OUTCOMES.has(r?.result as FillOutcome) ? (r!.result as FillOutcome) : "failed";
  const fields = Array.isArray(r?.fields) ? r!.fields.filter((n): n is number => Number.isInteger(n) && n > 0) : [];
  return { result, fields };
}

export async function listLogins(conn: CdpConnection, targetId: string): Promise<SavedLogin[]> {
  const r = await conn.send<{ logins?: unknown[] }>("Perch.listLogins", { targetId });
  return (r.logins ?? []).flatMap((l) => {
    const o = l as Record<string, unknown>;
    const loginId = text(o.loginId, 128);
    const username = text(o.username);
    const origin = text(o.origin);
    return loginId && username !== null && origin ? [{ loginId, username, origin }] : [];
  });
}

export async function fillLogin(conn: CdpConnection, targetId: string, loginId: string): Promise<FillResult> {
  return withFilledFields(conn, targetId, fillResult(await conn.send("Perch.fillLogin", { targetId, loginId })));
}

/**
 * The browser marks what it filled with `data-perch-filled` instead of naming node ids; read those
 * inputs' backend node ids from the tab so the next snapshot hides their values.
 */
async function withFilledFields(conn: CdpConnection, targetId: string, filled: FillResult): Promise<FillResult> {
  if (filled.fields.length || (filled.result !== "filled" && filled.result !== "needs-user")) return filled;
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  try {
    const { root } = await conn.send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 }, sessionId);
    const { nodeIds } = await conn.send<{ nodeIds: number[] }>("DOM.querySelectorAll", { nodeId: root.nodeId, selector: "[data-perch-filled]" }, sessionId);
    const fields: number[] = [];
    for (const nodeId of nodeIds.slice(0, 20)) {
      const { node } = await conn.send<{ node: { backendNodeId: number } }>("DOM.describeNode", { nodeId }, sessionId);
      if (Number.isInteger(node.backendNodeId)) fields.push(node.backendNodeId);
    }
    return { ...filled, fields };
  } catch {
    return filled;
  } finally {
    await conn.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}

export async function listCards(conn: CdpConnection, targetId: string): Promise<SavedCard[]> {
  const r = await conn.send<{ cards?: unknown[] }>("Perch.listCards", { targetId });
  return (r.cards ?? []).flatMap((c) => {
    const o = c as Record<string, unknown>;
    const cardId = text(o.cardId, 128);
    const network = text(o.network, 40) ?? "Card";
    const lastFour = text(o.lastFour, 4);
    const expiry = text(o.expiry, 10) ?? "";
    return cardId && lastFour && /^\d{4}$/.test(lastFour) ? [{ cardId, network, lastFour, expiry }] : [];
  });
}

export async function fillCard(conn: CdpConnection, targetId: string, cardId: string): Promise<FillResult> {
  return withFilledFields(conn, targetId, fillResult(await conn.send("Perch.fillCard", { targetId, cardId })));
}

/** The `chrome.tabs` id of a tab, which the extension needs; CDP only knows target ids. */
export async function extensionTabId(conn: CdpConnection, targetId: string): Promise<number> {
  const r = await conn.send<{ tabId?: unknown }>("Perch.getExtensionTabId", { targetId });
  if (!Number.isInteger(r.tabId)) throw new Error("the browser did not name the tab");
  return r.tabId as number;
}

/**
 * Fills a one-time code from Perch's authenticator into a frame of the tab. The code is made and
 * typed inside the extension's service worker (`perchFillCode`); only the outcome comes back.
 */
export async function fillCode(conn: CdpConnection, tabId: number, frameUrl: string): Promise<CodeOutcome> {
  const { targetInfos } = await conn.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
  const worker = targetInfos.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${PERCH_EXTENSION_ID}/`));
  if (!worker) return "no-code";
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: worker.targetId, flatten: true });
  try {
    const global = await conn.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression: "globalThis" }, sessionId);
    const r = await conn.send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
      "Runtime.callFunctionOn",
      {
        objectId: global.result.objectId,
        functionDeclaration: "function (tabId, frameUrl) { return typeof this.perchFillCode === 'function' ? this.perchFillCode(tabId, frameUrl) : 'no-code'; }",
        arguments: [{ value: tabId }, { value: frameUrl }],
        awaitPromise: true,
        returnByValue: true,
      },
      sessionId,
    );
    const value = r.result?.value;
    return !r.exceptionDetails && CODE_OUTCOMES.has(value as CodeOutcome) ? (value as CodeOutcome) : "no-field";
  } finally {
    await conn.send("Target.detachFromTarget", { sessionId }).catch(() => undefined);
  }
}
