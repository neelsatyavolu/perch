/**
 * Typed wrappers for the browser's `Perch` DevTools domain (plan 3b, task 1), the parts perchd
 * uses to fill logins, cards and one-time codes (task 7). Each fill returns an outcome, never a
 * value: the browser fills the page itself. Listings carry ids, usernames, the network and last
 * four digits, for the approval card only; they never go into a model message.
 */

import type { CdpConnection } from "../cdp/connection";

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
  return fillResult(await conn.send("Perch.fillLogin", { targetId, loginId }));
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
  return fillResult(await conn.send("Perch.fillCard", { targetId, cardId }));
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
