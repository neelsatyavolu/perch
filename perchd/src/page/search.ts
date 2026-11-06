/**
 * Web search for the agent: one call opens a results page and returns the top results as short
 * text. When an engine answers with a bot check, the next engine is used and the blocked one is
 * skipped for a while. In the benchmark runs agents lost many steps on blocked search pages and
 * gave up on research questions after a few of them; this keeps every search useful.
 */

import type { Tab } from "../browser/tab";
import { openPage } from "./navigation";

export type Engine = { name: string; url: (query: string) => string };
export type SearchResult = { title: string; url: string; snippet: string };

export const ENGINES: Engine[] = [
  { name: "DuckDuckGo", url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
  { name: "Bing", url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
  { name: "Brave Search", url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` },
];

/** How long an engine that showed a bot check is skipped. */
const SKIP_MS = 10 * 60_000;
const MAX_RESULTS = 8;
const LATE_RESULTS_MS = 700;

/** Words of a challenge or block page rather than a page of results. */
export const BLOCK_PAGE =
  /captcha|verify (that )?you are (a )?human|confirm (that )?(this search was made by|you are) a human|are you a robot|not a robot|unusual traffic|automated (queries|requests)|checking your browser|just a moment|verifying your request|access denied|complete the (security )?check|complete the (following )?challenge|press (and|&) hold/i;

/** Whether a page is a bot check or block page, from its title and opening text. */
export function looksBlocked(title: string, text: string): boolean {
  return BLOCK_PAGE.test(title) || BLOCK_PAGE.test(text.slice(0, 2000));
}

/** Result links on a results page: external, visible, with a title, and the text around them. */
const EXTRACT_JS = `(() => {
  const host = location.hostname.split('.').slice(-2).join('.');
  const real = (href) => {
    try {
      const u = new URL(href, location.href);
      for (const k of ['uddg', 'u', 'url', 'q']) {
        const v = u.searchParams.get(k);
        if (!v) continue;
        if (/^https?:/i.test(v)) return v;
        if (k === 'u' && v.startsWith('a1')) {
          try { const d = atob(v.slice(2).replace(/-/g, '+').replace(/_/g, '/')); if (/^https?:/i.test(d)) return d; } catch (e) {}
        }
      }
      return u.href;
    } catch (e) { return ''; }
  };
  const ours = (u) => { try { const h = new URL(u).hostname; return h === host || h.endsWith('.' + host); } catch (e) { return true; } };
  const seen = new Set();
  const results = [];
  // Result titles are links in headings on most engines; other links are a fallback.
  const inHeadings = [...document.querySelectorAll('h1 a[href], h2 a[href], h3 a[href], a[href] h2, a[href] h3')].map((el) => el.closest('a'));
  const anchors = inHeadings.length >= 2 ? inHeadings : [...document.querySelectorAll('a[href]')];
  for (const a of anchors) {
    const title = (a.innerText || '').replace(/\\s+/g, ' ').trim();
    if (title.length < 12 || /https?:\\/\\/|›/.test(title)) continue;
    const box = a.getBoundingClientRect();
    if (!box.width || !box.height) continue;
    const url = real(a.getAttribute('href'));
    if (!/^https?:/i.test(url) || ours(url) || seen.has(url)) continue;
    let block = a.parentElement;
    while (block && block !== document.body && block.parentElement && (block.innerText || '').length < title.length + 40) block = block.parentElement;
    const around = block && block !== document.body ? (block.innerText || '').replace(title, '').replace(/\\s+/g, ' ').trim() : '';
    seen.add(url);
    results.push({ title: title.slice(0, 150), url, snippet: around.length > 280 ? around.slice(0, 279) + '…' : around });
    if (results.length >= ${MAX_RESULTS}) break;
  }
  const text = document.body ? document.body.innerText : '';
  return { title: document.title, text: text.slice(0, 2000), length: text.length, results };
})()`;

/** Whether any result mentions a word of the query (words of four letters or more, or numbers). */
export function onTopic(query: string, results: SearchResult[]): boolean {
  const words = query.toLowerCase().match(/[\p{L}\p{N}]{4,}|\d+/gu) ?? [];
  if (words.length === 0) return true;
  return results.some((r) => {
    const text = `${r.title} ${r.snippet} ${r.url}`.toLowerCase();
    return words.some((w) => text.includes(w));
  });
}

type Page = { title: string; text: string; length: number; results: SearchResult[] };

/** Engines that showed a bot check, by name, with when they did. Kept per agent context. */
export type Skips = Map<string, number>;

export async function search(tab: Tab, query: string, opts: { engines?: Engine[]; skips: Skips; now?: () => number }): Promise<string> {
  const now = opts.now ?? Date.now;
  const engines = opts.engines ?? ENGINES;
  const usable = engines.filter((e) => now() - (opts.skips.get(e.name) ?? -Infinity) > SKIP_MS);
  const order = usable.length ? usable : engines;
  const blocked: string[] = [];
  let empty: string | null = null;
  for (const engine of order) {
    let found: Page;
    try {
      await openPage(tab, engine.url(query));
      found = await tab.evaluate<Page>(EXTRACT_JS);
      // Some engines fill in their results a moment after the page loads.
      for (let i = 0; i < 3 && found.results.length === 0 && !looksBlocked(found.title, found.text); i++) {
        await Bun.sleep(LATE_RESULTS_MS);
        found = await tab.evaluate<Page>(EXTRACT_JS);
      }
    } catch {
      blocked.push(`${engine.name} did not load`);
      continue;
    }
    if (looksBlocked(found.title, found.text) || (found.results.length === 0 && found.length < 300)) {
      opts.skips.set(engine.name, now());
      blocked.push(`${engine.name} showed a bot check`);
      continue;
    }
    // An engine that answered a different question (results that share no word with the query).
    if (found.results.length === 0 || !onTopic(query, found.results)) {
      empty ??= engine.name;
      continue;
    }
    const lead = blocked.length ? `${blocked.join("; ")}, so these results are from ${engine.name}.\n` : "";
    const list = found.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ""}`).join("\n");
    return `${lead}Results for "${query}" (${engine.name}):\n${list}\n\nSnippets can be out of date or wrong: open a result with navigate to read and confirm it.`;
  }
  const why = [...blocked, ...(empty ? [`${empty} found nothing`] : [])].join("; ");
  return `No results for "${query}" (${why}). Try fewer or different words: a name, a distinctive phrase in quotes, or one clue at a time.`;
}
