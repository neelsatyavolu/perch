/**
 * sign_in, fill_card and fill_code (plan 3b, task 7; spec 7.2): the browser fills a saved login or
 * card, and Perch's extension fills an authenticator code, without the model seeing a value. The
 * model gets one of a few fixed words back. Usernames and card digits appear only on the approval
 * card, which goes to the user, never to the model.
 *
 * Permissions (spec 7.4): signing in or filling a code on a site for the first time asks in Guard;
 * a card fill is a payment, so it always asks.
 */

import { extensionTabId, fillCard, fillCode, fillLogin, listCards, listLogins, type FillResult, type SavedCard, type SavedLogin } from "../browser/perch-domain";
import type { ToolSpec } from "../models/types";
import { rememberedSecrets, secretKey } from "../page/secrets";
import type { Kind } from "./permissions";
import type { ToolContext, ToolResult } from "./tools";

const spec = (name: string, description: string): ToolSpec => ({ name, description, parameters: { type: "object", properties: {}, required: [], additionalProperties: false } });

export const FILL_TOOL_SPECS: ToolSpec[] = [
  spec("sign_in", "Sign in on the current page with a login the user saved in Perch. Perch fills the form itself; you never see the username or password. Then click the page's sign-in button. Returns filled, no saved login, or needs you."),
  spec("fill_card", "Fill the payment form on the current page with a card the user saved in Perch. The user always approves first and types the security code. Returns filled, no saved card, or needs you."),
  spec("fill_code", "Fill a one-time sign-in code from Perch's authenticator into the current page. Returns filled, no saved code, or needs you."),
];

export const FILL_TOOLS: ReadonlySet<string> = new Set(FILL_TOOL_SPECS.map((s) => s.name));

/** Everything the model can be told. */
export const FILLED = "filled";
export const NO_LOGIN = "no saved login";
export const NO_CARD = "no saved card";
export const NO_CODE = "no saved code";
export const NEEDS_YOU = "needs you";
const NOT_IN_PERCH = "Saved logins, cards and codes can only be filled inside Perch.";

/** Sites where the user has let the agent sign in. Per perchd process for now. */
export type FillSites = { known(site: string): boolean; remember(site: string): void };

export function memoryFillSites(): FillSites {
  let sites: ReadonlySet<string> = new Set();
  return {
    known: (site) => sites.has(site),
    remember: (site) => void (sites = new Set([...sites, site])),
  };
}

const defaultSites = memoryFillSites();
const sitesOf = (ctx: ToolContext): FillSites => ctx.fillSites ?? defaultSites;

export function fillKind(name: string, site: string, ctx: ToolContext): Kind {
  if (name === "fill_card") return "payment";
  return sitesOf(ctx).known(site) ? "change" : "risky";
}

/** "neel@…", "ne…": enough for the user to tell logins apart on the card. */
export function maskUsername(username: string): string {
  const at = username.indexOf("@");
  if (at > 0) return `${username.slice(0, at + 1)}…`;
  return username.length <= 2 ? "…" : `${username.slice(0, 2)}…`;
}

function pickLogin(logins: SavedLogin[], pageOrigin: string): SavedLogin | undefined {
  return logins.find((l) => l.origin === pageOrigin) ?? logins[0];
}

async function pageOrigin(ctx: ToolContext): Promise<string> {
  try {
    return new URL(await ctx.tab!.url()).origin;
  } catch {
    return "";
  }
}

/** The approval card's line. Lists the saved items through the browser; nothing here reaches the model. */
export async function fillSummary(ctx: ToolContext, name: string, site: string): Promise<string> {
  if (!ctx.browser.perch || !ctx.tab) return `Use ${name} on ${site}`;
  if (name === "sign_in") {
    const logins = await listLogins(ctx.browser.conn, ctx.tab.id).catch(() => []);
    const login = pickLogin(logins, await pageOrigin(ctx));
    if (!login) return `Sign in to ${site}`;
    return `Sign in to ${site} as ${maskUsername(login.username)}${logins.length > 1 ? ` (1 of ${logins.length} saved logins)` : ""}`;
  }
  if (name === "fill_card") {
    const card = (await listCards(ctx.browser.conn, ctx.tab.id).catch(() => []))[0];
    return card ? `Fill ${card.network} ending ${card.lastFour} on ${site}` : `Fill a saved card on ${site}`;
  }
  return `Fill a one-time code on ${site}`;
}

/** The filled fields join the tab's secret set, so the next snapshot shows them as ••••. */
function hideFilled(ctx: ToolContext, filled: FillResult): void {
  if (!ctx.tab) return;
  const secrets = rememberedSecrets(ctx.tab);
  for (const id of filled.fields) secrets.add(secretKey(id));
}

function outcome(r: FillResult): string {
  return r.result === "filled" ? FILLED : NEEDS_YOU;
}

export async function runFillTool(ctx: ToolContext, name: string): Promise<ToolResult> {
  if (!ctx.browser.perch) return { content: NOT_IN_PERCH, isError: true };
  if (!ctx.tab) return { content: "No tab is open. Open the sign-in page first.", isError: true };
  // The same name session.ts gives the site when it decides whether to ask.
  const site = await ctx.tab.url().then((u) => new URL(u).hostname || "a new tab", () => "a new tab");
  const conn = ctx.browser.conn;
  const tab = ctx.tab;
  let content: string;
  if (name === "sign_in") {
    const login = pickLogin(await listLogins(conn, tab.id), await pageOrigin(ctx));
    if (!login) return { content: NO_LOGIN };
    const r = await fillLogin(conn, tab.id, login.loginId);
    hideFilled(ctx, r);
    content = outcome(r);
  } else if (name === "fill_card") {
    const card: SavedCard | undefined = (await listCards(conn, tab.id))[0];
    if (!card) return { content: NO_CARD };
    const r = await fillCard(conn, tab.id, card.cardId);
    hideFilled(ctx, r);
    content = outcome(r);
  } else {
    const r = await fillCode(conn, await extensionTabId(conn, tab.id), await tab.url());
    content = r === "filled" ? FILLED : r === "no-code" ? NO_CODE : NEEDS_YOU;
  }
  if (content === FILLED && name !== "fill_card") sitesOf(ctx).remember(site);
  return { content };
}
