/**
 * The readable text of the tab the user is looking at, sent with a chat message so a question
 * about the page ("what does this say", "is this right") needs no extra round trip. Plain text
 * only: the agent still reads the page with snapshot before it clicks or types, so its element
 * references stay its own.
 */

import type { CdpConnection } from "../cdp/connection";

export const PAGE_TEXT_LIMIT = 6_000;
const TIMEOUT_MS = 1_500;

const READ = `(() => {
  const sel = String(getSelection?.() ?? "").trim();
  const body = (document.body?.innerText ?? "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return JSON.stringify({ selection: sel.slice(0, 4000), text: body.slice(0, ${PAGE_TEXT_LIMIT}), more: body.length > ${PAGE_TEXT_LIMIT} });
})()`;

export type PageText = { selection: string; text: string; more: boolean };

/** Null when the tab can't be read in time (a busy or special page); the task goes without it. */
export async function readPageText(conn: CdpConnection, targetId: string): Promise<PageText | null> {
  let sessionId: string | undefined;
  const work = (async () => {
    ({ sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true }));
    const { result } = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", { expression: READ, returnByValue: true }, sessionId);
    return result.value ? (JSON.parse(result.value) as PageText) : null;
  })();
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), TIMEOUT_MS));
  try {
    return await Promise.race([work, timeout]).catch(() => null);
  } finally {
    void work.finally(() => sessionId && conn.send("Target.detachFromTarget", { sessionId }).catch(() => undefined)).catch(() => undefined);
  }
}

/** The page text as a part of the task. */
export function pageTextContext(page: PageText): string {
  const parts: string[] = [];
  if (page.selection) parts.push(`The user has this text selected on the page:\n"""\n${page.selection}\n"""`);
  if (page.text)
    parts.push(
      `The text of the page the user is looking at${page.more ? ` (first ${PAGE_TEXT_LIMIT} characters)` : ""}. Answer from it when it is enough; read the page with snapshot before clicking or typing:\n"""\n${page.text}\n"""`,
    );
  return parts.join("\n\n");
}
