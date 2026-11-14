/**
 * Whether memory already knows enough for what Build my memory is for (memory/build-chat.ts):
 * writing as the user, buying for them on a new site, and filling in their details. Memory brought
 * over from Aside often does; then Perch doesn't build it again, or only fills the gaps.
 */

import type { Page } from "./page";

export type Coverage = { readonly enough: boolean; readonly facts: number; readonly missing: readonly string[] };

const WRITING = /\b(tone|sign[- ]?off|signs (off|emails)|writes|writing|greeting|lowercase|emoji|formal|casual)\b/i;
/** Kinds of contact detail; the user's own page needs at least two of them. */
const CONTACT_KINDS: readonly RegExp[] = [
  /@[\w-]+\.\w|\be-?mail\b/i,
  /\bphone|mobile\b|\+?\d[\d ().-]{7,}\d/i,
  /\baddress|lives (in|at)|street|\bst\b|avenue|zip|postcode\b/i,
];

type Need = { readonly gap: string; readonly met: (pages: readonly Page[]) => boolean };

const facts = (pages: readonly Page[]) => pages.flatMap((p) => p.current.map((f) => f.text));
/** Distinct pages in a category: an overflow page ("sam-2.md") is part of its first page. */
const pagesIn = (pages: readonly Page[], category: string) =>
  new Set(pages.filter((p) => p.category === category && p.current.length > 0).map((p) => p.path.replace(/-\d+\.md$/, ".md"))).size;

/** What each task needs, as a gap the build chat can fill when it's missing. */
const NEEDS: readonly Need[] = [
  {
    gap: "your contact details and addresses (name, email, phone, home and shipping address)",
    met: (p) => {
      const own = facts(p.filter((x) => x.category === "user"));
      return CONTACT_KINDS.filter((kind) => own.some((t) => kind.test(t))).length >= 2;
    },
  },
  { gap: "the people you write to most, and how you know them", met: (p) => pagesIn(p, "people") >= 3 },
  { gap: "how you write (tone, greetings, sign-offs, length) in email and chat", met: (p) => pagesIn(p, "writing") > 0 || facts(p).filter((t) => WRITING.test(t)).length >= 3 },
  { gap: "the sites and services you use, your accounts, sizes and shopping preferences", met: (p) => pagesIn(p, "sites") + pagesIn(p, "companies") >= 5 },
];

const ENOUGH_FACTS = 100;
/** Pages that say something about the user's life: not dated notes, logs or loose topics. */
const COUNTED = (p: Page) => !["episodic", "log", "concepts"].includes(p.category);

export function memoryCoverage(pages: readonly Page[]): Coverage {
  const live = pages.filter(COUNTED);
  const count = facts(live).length;
  const missing = [...NEEDS.filter((n) => !n.met(live)).map((n) => n.gap), ...(count < ENOUGH_FACTS ? ["more about you in general"] : [])];
  return { enough: missing.length === 0, facts: count, missing };
}
