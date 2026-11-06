/**
 * What an action changed on the page, said plainly. Models, small ones above all, rarely compare
 * two long snapshots themselves: a filter click that only toggled its own button, or a Submit
 * that showed an error line, looked like success to them. These notes go above the new page.
 */

/** At most this many changed lines count as "only a small part of the page changed". */
const SMALL = 3;
/** Pages shorter than this are too small to tell a partial update from a full one. */
const MIN_LINES = 12;
const SHOWN = 3;

/** Lines that read as a message to the user: errors, validation, confirmations. */
const MESSAGE =
  /\b(error|invalid|required|must|please (enter|select|choose|provide|fill|add|check)|not valid|incorrect|failed|unable|try again|out of stock|unavailable|sold out|success(fully)?|thank you|confirmed|added to (your )?(cart|bag|basket)|submitted|saved|sent)\b/i;

/** `small`: only a few lines changed and none of them is a message, so the action may have failed. */
export type ChangeNotes = { unchanged: boolean; small?: boolean; text: string };

/** A snapshot line without its ref, so a list that redrew with new refs reads as the same. */
const plain = (line: string) => line.replace(/ \[ref=e\d+\]/, "").trim();
const withoutRef = (text: string) => text.split("\n").map(plain).filter(Boolean);

/** Lines in `a` that `b` lacks, counting repeats. */
function missing(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const line of b) left.set(line, (left.get(line) ?? 0) + 1);
  return a.filter((line) => {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    return n === 0;
  });
}

export function changeNotes(opts: { before: string; after: string; sameUrl: boolean }): ChangeNotes {
  if (!opts.sameUrl) return { unchanged: false, text: "" };
  const before = withoutRef(opts.before);
  const after = withoutRef(opts.after);
  const added = missing(after, before);
  const removed = missing(before, after);
  if (added.length === 0 && removed.length === 0) return { unchanged: true, small: true, text: "" };
  const notes: string[] = [];
  const messages = added.filter((line) => MESSAGE.test(line) && /^- (text|heading|alert|status)/.test(line));
  if (messages.length) notes.push(`New on the page: ${messages.slice(0, SHOWN).map((l) => l.replace(/^- /, "")).join("; ")}`);
  const changed = Math.max(added.length, removed.length);
  const small = changed <= SMALL && before.length >= MIN_LINES && messages.length === 0;
  if (small) {
    const shown = rawAdded(opts.before, opts.after).slice(0, SHOWN).map((l) => l.replace(/^- /, ""));
    const what = shown.length ? `: ${shown.join("; ")}` : added.length === 0 ? ` (${removed.length} gone)` : "";
    notes.push(
      `Only ${changed} line${changed === 1 ? "" : "s"} of the page changed${what}. The rest is the same: if this was meant to filter, sort or load results, they did not update.`,
    );
  }
  return { unchanged: false, small, text: notes.join("\n") };
}

/** The changed lines as the model will see them, with their refs. */
function rawAdded(before: string, after: string): string[] {
  const seen = new Set(withoutRef(before));
  return after.split("\n").map((l) => l.trim()).filter((l) => l && !seen.has(plain(l)));
}
