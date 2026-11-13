/**
 * Folds the site's menus that repeat from one snapshot to the next. A side menu of twenty links
 * shown again after every click costs the model a page of reading for nothing; when a menu is the
 * same as in the last snapshot (refs aside), it is shown as one line that still names each link
 * and its ref, so the model can use it.
 */

const LANDMARK = /^(\s*)- (navigation|complementary|banner|contentinfo)\b/;
const ITEM = /^\s*- \S+ "((?:[^"\\]|\\.)*)" \[ref=(e\d+)\]/;
const REF = / \[ref=e\d+\]/g;

type Block = { start: number; end: number; header: string };

/** Top-level menu blocks: a landmark line and every deeper-indented line under it. */
function blocks(lines: readonly string[]): Block[] {
  const found: Block[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(LANDMARK);
    if (!m) continue;
    const indent = m[1]!.length;
    let end = i + 1;
    while (end < lines.length && lines[end]!.search(/\S/) > indent) end++;
    found.push({ start: i, end, header: lines[i]! });
    i = end - 1;
  }
  return found;
}

/** A block's content without refs, which change from one snapshot to the next. */
function signature(lines: readonly string[], b: Block): string {
  return lines.slice(b.start, b.end).map((l) => l.replace(REF, "")).join("\n");
}

export function foldRepeats(text: string, previous: string | undefined): string {
  if (!previous) return text;
  const before = previous.split("\n");
  const seen = new Set(blocks(before).filter((b) => b.end - b.start > 3).map((b) => signature(before, b)));
  if (seen.size === 0) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  let at = 0;
  for (const b of blocks(lines)) {
    if (b.end - b.start <= 3 || !seen.has(signature(lines, b))) continue;
    out.push(...lines.slice(at, b.start));
    const items = lines.slice(b.start + 1, b.end).flatMap((l) => {
      const m = l.match(ITEM);
      return m ? [`${m[1]} [${m[2]}]`] : [];
    });
    const head = b.header.replace(REF, "").replace(/:$/, "");
    out.push(`${head} (same as the last snapshot): ${items.join(" · ") || "no links"}`);
    at = b.end;
  }
  if (at === 0) return text;
  out.push(...lines.slice(at));
  return out.join("\n");
}
