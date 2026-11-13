/**
 * Compiles element-hiding filters from every list into the static generic stylesheet and the
 * per-site data the service worker applies. Build time only.
 *
 * Generic selectors no site excepts go in generic.css. A generic selector that some site excepts
 * (`site#@#sel`, or `~site##sel`) goes in the data instead, so the service worker can leave it out
 * on that site rather than trying to undo a display:none it cannot know the original value of.
 */

import { type CosmeticData } from "./data";
import { parseCosmetic } from "./parse";
import { hideCss } from "./selector";

export type CosmeticStats = {
  generic: number;
  /** Generic selectors held back from generic.css because some site excepts them. */
  genericExcepted: number;
  siteSelectors: number;
  sites: number;
  exceptions: number;
  genericHideSites: number;
  elemHideSites: number;
  skipped: Record<string, number>;
};

export type CompiledCosmetic = { genericCss: string; data: CosmeticData; stats: CosmeticStats };

export function compileCosmetic(lists: readonly { id: string; text: string }[]): CompiledCosmetic {
  const generic = new Set<string>();
  const exceptedEverywhere = new Set<string>();
  const hide = new Map<string, Set<string>>();
  const unhide = new Map<string, Set<string>>();
  const genericHide = new Set<string>();
  const elemHide = new Set<string>();
  const skipped: Record<string, number> = {};
  let exceptions = 0;

  const add = (map: Map<string, Set<string>>, host: string, selector: string) => {
    const set = map.get(host) ?? new Set<string>();
    set.add(selector);
    map.set(host, set);
  };

  for (const { text } of lists) {
    for (const line of text.split(/\r?\n/)) {
      const parsed = parseCosmetic(line);
      if (!parsed) continue;
      if ("skip" in parsed) {
        skipped[parsed.skip] = (skipped[parsed.skip] ?? 0) + 1;
        continue;
      }
      if ("hideSwitch" in parsed) {
        for (const host of parsed.hideSwitch.hosts) (parsed.hideSwitch.kind === "elemhide" ? elemHide : genericHide).add(host);
        continue;
      }
      const { exception, include, exclude, selector } = parsed.filter;
      if (exception) {
        exceptions++;
        if (include.length === 0) exceptedEverywhere.add(selector);
        for (const host of include) add(unhide, host, selector);
        continue;
      }
      if (include.length === 0) generic.add(selector);
      for (const host of include) add(hide, host, selector);
      for (const host of exclude) add(unhide, host, selector);
    }
  }

  for (const selector of exceptedEverywhere) {
    generic.delete(selector);
    for (const set of hide.values()) set.delete(selector);
  }
  const excepted = new Set([...unhide.values()].flatMap((set) => [...set]));
  const staticGeneric = [...generic].filter((s) => !excepted.has(s)).sort();
  const heldBack = [...generic].filter((s) => excepted.has(s));

  // Exceptions only matter for selectors something hides.
  const hidden = new Set([...heldBack, ...[...hide.values()].flatMap((set) => [...set])]);
  const index = new Map<string, number>();
  const selectors: string[] = [];
  const id = (s: string) => {
    let i = index.get(s);
    if (i === undefined) {
      i = selectors.push(s) - 1;
      index.set(s, i);
    }
    return i;
  };
  const toRecord = (map: Map<string, Set<string>>, keep: (s: string) => boolean) =>
    Object.fromEntries(
      [...map.entries()]
        .map(([host, set]) => [host, [...set].filter(keep).sort().map(id)] as const)
        .filter(([, ids]) => ids.length > 0)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );

  const data: CosmeticData = {
    generic: heldBack.sort().map(id),
    hide: toRecord(hide, () => true),
    unhide: toRecord(unhide, (s) => hidden.has(s)),
    genericHide: [...genericHide].sort(),
    elemHide: [...elemHide].sort(),
    selectors,
  };
  return {
    genericCss: hideCss(staticGeneric),
    data,
    stats: {
      generic: staticGeneric.length,
      genericExcepted: heldBack.length,
      siteSelectors: Object.values(data.hide).reduce((n, ids) => n + ids.length, 0),
      sites: Object.keys(data.hide).length,
      exceptions,
      genericHideSites: data.genericHide.length,
      elemHideSites: data.elemHide.length,
      skipped,
    },
  };
}
