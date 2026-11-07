/**
 * A memory page as the Memory page edits it: plain markdown with a title and "Current" and
 * "History" lists, without the frontmatter and per-fact notes the store keeps. Writing it back
 * keeps each unchanged fact's date and source.
 */

import { factKey, renderPage, type Fact, type Page } from "../../memory/page";
import { cleanText, looksSecret, MAX_TITLE } from "../../memory/sanitize";
import { AppError } from "../runs";

const MAX_FACTS = 200;
const FIXED = new Set(["USER.md", "MEMORY.md"]);

export function pageBody(page: Page): string {
  const lines = [`# ${page.title}`, "", "## Current", ...page.current.map((f) => `- ${f.text}`)];
  if (page.history.length) lines.push("", "## History", ...page.history.map((f) => `- ${f.text}`));
  return `${lines.join("\n")}\n`;
}

export const pageBytes = (page: Page): number => Buffer.byteLength(renderPage(page));

/** The page with the edited body; bullet lines outside any section count as current facts. */
export function editedPage(page: Page, body: string, now: string): Page {
  const known = new Map([...page.current, ...page.history].map((f) => [factKey(f.text), f]));
  const current: Fact[] = [];
  const history: Fact[] = [];
  let title = page.title;
  let section: Fact[] = current;
  for (const line of body.split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (heading) {
      if (heading[1] === "#") title = cleanText(heading[2]!, MAX_TITLE) || title;
      else section = /^history\b/i.test(heading[2]!) ? history : current;
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const text = bullet ? cleanText(bullet[1]!) : "";
    if (!text) continue;
    if (looksSecret(text)) throw new AppError("That looks like a password, key or code. Perch doesn't keep those in memory.");
    const before = known.get(factKey(text));
    section.push(before ? { ...before, text } : { text, added: now, source: "user" });
  }
  if (current.length > MAX_FACTS || history.length > MAX_FACTS) throw new AppError(`A page holds up to ${MAX_FACTS} facts in each list`);
  return { ...page, title: FIXED.has(page.path) ? page.title : title, current, history };
}
