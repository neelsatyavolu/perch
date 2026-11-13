/**
 * What an approval card shows (spec 7.4, 6.6): exactly what will be sent, and a confirm button
 * that names the action ("Send", "Pay $42.18", "Delete 3 emails"), never "OK" or "Confirm".
 */

import type { ApprovalRequest } from "../agent/session";
import type { ApprovalCard } from "./protocol";

const GENERIC = /^(ok|okay|confirm|yes|submit|continue|next|done|apply|save|go|proceed)$/i;
const DESTRUCTIVE = /\b(delete|remove|trash|discard|erase|cancel subscription|close account)\b/i;
const MAX_LABEL = 40;
/** Fields whose Enter sends something, named by what goes out. A comment box is checked first. */
const SENDS = [
  { field: /\bcomment/i, title: "Post a comment", confirm: "Post comment" },
  { field: /\b(message|reply|chat|dm)\b/i, title: "Send a message", confirm: "Send message" },
] as const;

type Ids = { id: string; chatId: string; runId: string };

export function describeApproval(req: ApprovalRequest, ids: Ids): ApprovalCard {
  const a = req.call.args;
  const what = req.target ? `${req.target.role} "${req.target.name}"` : "";
  const base = { ...ids, site: req.site, kind: req.kind === "read" ? "change" : req.kind } as const;
  const card = (title: string, confirm: string, extra: Partial<ApprovalCard> = {}): ApprovalCard => ({
    ...base,
    title,
    confirm: cut(confirm),
    danger: req.kind === "payment" || DESTRUCTIVE.test(confirm),
    ...extra,
  });
  switch (req.call.name) {
    case "type": {
      const submit = Boolean(a.submit);
      const sends = submit ? SENDS.find((s) => s.field.test(req.target?.name ?? "")) : undefined;
      if (sends) return card(sends.title, sends.confirm, { body: String(a.text ?? "") });
      return card(`Type into ${what || "a field"}${submit ? " and press Enter" : ""}`, submit ? "Type and press Enter" : "Type text", { body: String(a.text ?? "") });
    }
    case "click": {
      const name = req.target?.name.trim() ?? "";
      const confirm = !name || GENERIC.test(name) ? `Click "${name || "this"}"` : sentenceCase(name);
      const fields = formFields(req.summary);
      return card(`Click ${what || "an element"}`, confirm, fields.length ? { fields } : {});
    }
    case "press":
      return card(`Press ${a.key}${what ? ` in ${what}` : ""}`, `Press ${a.key}`);
    case "select":
      return card(`Choose "${a.value}"${what ? ` in ${what}` : ""}`, `Choose "${a.value}"`);
    case "upload": {
      const paths = (a.paths as string[] | undefined) ?? [];
      return card(`Attach ${paths.length === 1 ? "a file" : `${paths.length} files`}${what ? ` to ${what}` : ""}`, `Upload ${paths.length === 1 ? "1 file" : `${paths.length} files`}`, {
        fields: paths.map((p) => ({ label: "File", value: p })),
      });
    }
    case "click_at":
      return req.target?.name
        ? card(`Click ${what}`, `Click "${req.target.name.trim()}"`)
        : card(`Click at ${a.x}, ${a.y} on the page`, `Click at ${a.x}, ${a.y}`);
    case "repl":
      return card("Run a script on the page", "Run script", { body: String(a.code ?? "") });
    case "sign_in":
      return card(req.summary || `Sign in to ${req.site}`, "Sign in");
    case "fill_card":
      return card(req.summary || `Fill a saved card on ${req.site}`, "Fill card");
    case "fill_code":
      return card(req.summary || `Fill a one-time code on ${req.site}`, "Fill code");
    default:
      return card(req.summary || `Use ${req.call.name}`, `Allow ${req.call.name}`);
  }
}

/** The "with Label: value; ..." part of a session summary, as fields. */
function formFields(summary: string): { label: string; value: string }[] {
  const match = summary.match(/ with (.+) on [^ ]+$/);
  if (!match) return [];
  return match[1]!
    .split("; ")
    .map((pair) => {
      const at = pair.indexOf(": ");
      return at > 0 ? { label: pair.slice(0, at).trim(), value: pair.slice(at + 2).trim() } : null;
    })
    .filter((f): f is { label: string; value: string } => Boolean(f?.label));
}

function sentenceCase(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.charAt(0).toUpperCase() + flat.slice(1);
}

function cut(label: string): string {
  return label.length <= MAX_LABEL ? label : `${label.slice(0, MAX_LABEL - 1).trimEnd()}…`;
}
