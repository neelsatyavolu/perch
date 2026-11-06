/**
 * Permission modes (spec 7.4). Every tool call is classified, then the mode and any site rule
 * decide whether it runs, waits for the user, or is blocked.
 *
 *   read     looking around: navigate, snapshot, scroll, read-only REPL
 *   change   ordinary edits: typing, choosing, dragging, clicking "Next"
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
/** Roles whose drag moves a value along a track rather than dropping something somewhere. */
const ALONG_TRACK = new Set(["slider", "scrollbar", "separator"]);

/**
 * `drop` is where a drag ends (its `to` element). A drag is judged as a click on its source and,
 * when it has one, a click on what it is dropped on; the stricter of the two wins. A drop target
 * that could not be identified counts as risky, and so does a drag by pixels, except along a slider.
 */
export function classify(call: ToolCall, target?: Target, page: PageContext = {}, drop?: Target): Kind {
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
  if (call.name === "drag") {
    const source = clickKind(target, guarded);
    if (call.args.to !== undefined) return stricter(source, drop ? clickKind(drop, guarded) : "risky");
    // A drag by pixels lands on whatever is there (a Trash or Delete zone, say), which nobody
    // identified. Only a slider-like source moves along its own track with nothing to drop on.
    const still = !Number(call.args.dx ?? 0) && !Number(call.args.dy ?? 0);
    return still || ALONG_TRACK.has(target?.role ?? "") ? source : stricter(source, "risky");
  }
  if (call.name === "press" && !isEnter(call)) return "change";
  if (call.name === "press" || call.name === "type") {
    // Enter, or typing with submit: it sends whatever form the field is in.
    if (guarded) return "payment";
    const searchField = target?.role === "searchbox" || target?.role === "combobox" || SEARCHY.test(name);
    return searchField ? "change" : "risky";
  }
  if (call.name === "hover") return "read";
  if (call.name === "click") return clickKind(target, guarded);
  return "risky";
}

/** Roles whose click only selects an option; the form's own button is what commits it. */
const CHOICES = new Set(["radio", "checkbox", "menuitemradio", "menuitemcheckbox", "option", "tab"]);

function clickKind(target: Target | undefined, guarded: boolean): Kind {
  if (!target) return "risky";
  // "Drop-off at a Best Buy store" is a choice, not a purchase.
  if (CHOICES.has(target.role)) return "change";
  const name = target.name;
  if (PAYMENT.test(name) || PASSWORD.test(name) || charges(target, guarded)) return "payment";
  if (guarded && ADVANCES.test(name)) return "payment";
  if (RISKY.test(name)) return "risky";
  return "change";
}

const ORDER: Kind[] = ["read", "change", "risky", "payment"];
const stricter = (a: Kind, b: Kind): Kind => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b);

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
