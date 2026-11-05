/**
 * Permission modes (spec 7.4). Every tool call is classified, then the mode and any site rule
 * decide whether it runs, waits for the user, or is blocked.
 *
 *   read     looking around: navigate, snapshot, scroll, read-only REPL
 *   change   ordinary edits: typing, choosing, clicking "Next"
 *   risky    sends, posts, deletes, shares, uploads, Enter in a text field, anything unseen
 *   payment  money and passwords: always asks, even in Skip confirmation
 */

import type { ToolCall } from "../models/types";

export type Mode = "ask" | "guard" | "skip";
export type Kind = "read" | "change" | "risky" | "payment";
export type SiteRule = "allow" | "ask" | "never";
export type Decision = "run" | "ask" | "block";
export type Target = { role: string; name: string };

const READ_TOOLS = new Set(["navigate", "snapshot", "screenshot", "scroll", "hover", "wait_for", "back", "tabs", "open_tab", "switch_tab", "done"]);
const CHANGE_TOOLS = new Set(["click", "type", "select", "press"]);

const RISKY = /\b(send|post|publish|submit|delete|remove|discard|share|invite|transfer|confirm|sign up|unsubscribe|reply|forward|archive|trash)\b/i;
const PAYMENT = /\b(pay|buy|place order|purchase|checkout|check out|subscribe|book now|confirm payment|donate|change password|update password|reset password)\b/i;
const MONEY = /[$€£¥₹]\s?\d|\d\s?(usd|eur|gbp|inr|jpy)\b/i;
const REPL_WRITES = /\.(click|submit|requestSubmit|dispatchEvent|focus|remove|append\w*|insert\w*|set\w*)\s*\(|\.(value|checked|innerHTML|textContent)\s*=|\bfetch\s*\(|XMLHttpRequest|sendBeacon|\blocation\b\s*(\.\w+\s*)?=|\bopen\s*\(|execCommand/;
const SEARCHY = /search|find|filter|lookup/i;

export function classify(call: ToolCall, target?: Target): Kind {
  const name = target?.name ?? "";
  if (READ_TOOLS.has(call.name)) return "read";
  if (call.name === "repl") return REPL_WRITES.test(String(call.args.code ?? "")) ? "risky" : "read";
  if (call.name === "upload" || call.name === "click_at" || call.name === "type_text") return "risky";
  if (!CHANGE_TOOLS.has(call.name)) return "risky";
  if (call.name === "click" || (call.name === "press" && isEnter(call))) {
    if (PAYMENT.test(name) || MONEY.test(name)) return "payment";
    if (call.name === "click" && RISKY.test(name)) return "risky";
    if (call.name === "press") {
      const searchField = target?.role === "searchbox" || target?.role === "combobox" || SEARCHY.test(name);
      return searchField ? "change" : "risky";
    }
  }
  return "change";
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
