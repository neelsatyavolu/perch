/**
 * Permission modes (spec 7.4). Every tool call is classified, then the mode and any site rule
 * decide whether it runs, waits for the user, or is blocked.
 *
 *   read     looking around: navigate, snapshot, scroll, read-only REPL
 *   change   ordinary edits: typing, choosing, clicking "Next"
 *   risky    sends, posts, deletes, shares, uploads, Enter in a text field, an element not in the last snapshot
 *   payment  money and passwords, and anything that moves a checkout or password form forward:
 *            always asks, even in Skip confirmation
 */

import { appTool } from "../apps/index";
import type { ToolCall } from "../models/types";

export type Mode = "ask" | "guard" | "skip";
export type Kind = "read" | "change" | "risky" | "payment";
export type SiteRule = "allow" | "ask" | "never";
export type Decision = "run" | "ask" | "block";
export type Target = { role: string; name: string };

/** What the page around an action looks like: a checkout, or a password change. */
export type PageContext = { payment?: boolean; passwordChange?: boolean };

const READ_TOOLS = new Set(["navigate", "snapshot", "screenshot", "scroll", "hover", "wait_for", "back", "tabs", "open_tab", "switch_tab", "done"]);

const RISKY = /\b(send|post|publish|submit|delete|remove|discard|share|invite|transfer|confirm|sign up|unsubscribe|reply|forward|archive|trash)\b/i;
const PAYMENT =
  /\b(pay|buy|purchase|checkout|check out|place (your )?order|submit (your )?order|complete (your )?(order|purchase|booking|reservation|payment|checkout)|reserve|request to book|book( now| it)?|confirm (and|&) pay|confirm (your )?(booking|purchase|payment|order|reservation)|subscribe|donate|start (your )?(free )?trial|upgrade)\b/i;
const MONEY = /[$€£¥₹]\s?\d|\d\s?(usd|eur|gbp|inr|jpy)\b/i;
/** A button that is a price ("$9.99") or charges one ("Get it for $4.99", "Continue ($19.99)"). */
const PRICE_ONLY = /^\s*(price:?\s*)?(us|ca|a)?[$€£¥₹]\s?\d[\d,.]*\s*$/i;
const FOR_PRICE = /\bfor\s*(us|ca|a)?[$€£¥₹]\s?\d/i;
const PASSWORD = /\b(change|update|reset|save|set) (your |the )?password\b/i;
/** Buttons that move a checkout or a password form forward. */
const ADVANCES = /\b(continue|next|confirm|complete|submit|save|update|done|apply|finish|proceed|place|order|pay|book|reserve|change|set|verify)\b/i;
const SEARCHY = /search|find|filter|lookup/i;

export function classify(call: ToolCall, target?: Target, page: PageContext = {}): Kind {
  const name = target?.name ?? "";
  const guarded = Boolean(page.payment || page.passwordChange);
  const app = appTool(call.name);
  if (app) return app.kind(call.args);
  if (READ_TOOLS.has(call.name)) return "read";
  // The REPL runs in a read-only sandbox (src/page/repl.ts); writes go through the other tools.
  if (call.name === "repl") return "read";
  if (call.name === "upload") return "risky";
  // A file in the chat's own folder touches nothing outside it (spec 7.4).
  if (call.name === "write_file") return "change";
  if (call.name === "click_at" || call.name === "type_text") return guarded ? "payment" : "risky";
  if (call.name === "select" || (call.name === "type" && !call.args.submit)) return "change";
  if (call.name === "press" && !isEnter(call)) return "change";
  if (call.name === "press" || call.name === "type") {
    // Enter, or typing with submit: it sends whatever form the field is in.
    if (guarded) return "payment";
    const searchField = target?.role === "searchbox" || target?.role === "combobox" || SEARCHY.test(name);
    return searchField ? "change" : "risky";
  }
  if (call.name === "click" || call.name === "hover") {
    if (call.name === "hover") return "read";
    if (!target) return "risky";
    if (PAYMENT.test(name) || PASSWORD.test(name) || charges(target, guarded)) return "payment";
    if (guarded && ADVANCES.test(name)) return "payment";
    if (RISKY.test(name)) return "risky";
    return "change";
  }
  return "risky";
}

/**
 * A money amount alone is not a payment: filters ("Under $25,000"), salary bands and price labels
 * carry one too. It counts on a checkout page, or on a button that charges it.
 */
function charges(target: Target, guarded: boolean): boolean {
  if (!MONEY.test(target.name)) return false;
  if (guarded) return true;
  if (target.role !== "button") return false;
  return PRICE_ONLY.test(target.name) || FOR_PRICE.test(target.name) || ADVANCES.test(target.name);
}

function isEnter(call: ToolCall): boolean {
  return /(^|\+)enter$/i.test(String(call.args.key ?? ""));
}

export function needsApproval(mode: Mode, kind: Kind, siteRule?: SiteRule): Decision {
  if (kind === "read") return "run";
  if (siteRule === "never") return "block";
  if (siteRule === "ask") return "ask";
  if (kind === "payment") return "ask";
  if (siteRule === "allow") return "run";
  if (mode === "ask") return "ask";
  if (mode === "guard") return kind === "risky" ? "ask" : "run";
  return "run";
}
