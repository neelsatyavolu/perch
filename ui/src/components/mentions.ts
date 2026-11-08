/** `@` in the composer: which tab the user is naming, and the draft after they pick one. */

import type { TabInfo } from "../api/types";

const AT = /(^|\s)@([^\s@]{0,40})$/;
const MAX_LABEL = 40;

/** The text after an `@` at the end of the draft, or null when the user is not naming a tab. */
export function mentionQuery(draft: string): string | null {
  const m = draft.match(AT);
  return m ? m[2]! : null;
}

/** Tabs whose title or address contains the query, at most `max`. */
export function matchTabs(tabs: readonly TabInfo[], query: string, max = 8): TabInfo[] {
  const q = query.toLowerCase();
  return tabs.filter((t) => !q || t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)).slice(0, max);
}

/** The label a picked tab leaves in the draft. */
export function mentionLabel(tab: TabInfo): string {
  const title = tab.title.replace(/\s+/g, " ").trim() || hostOf(tab.url) || "tab";
  return title.length <= MAX_LABEL ? title : `${title.slice(0, MAX_LABEL - 1).trimEnd()}…`;
}

/** The draft with the `@query` at its end replaced by `@<label> `. */
export function applyMention(draft: string, tab: TabInfo): string {
  return draft.replace(AT, (_, lead: string) => `${lead}@${mentionLabel(tab)} `);
}

/** The picked tabs whose `@label` is still in the text when it is sent. */
export function keptMentions(text: string, picked: readonly TabInfo[]): TabInfo[] {
  return picked.filter((t, i) => text.includes(`@${mentionLabel(t)}`) && picked.findIndex((x) => x.id === t.id) === i);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}
