/** Turns query results and matched commands into the command bar's rows, in display order. */

import type { CommandBarItem, CommandBarKind, CommandBarResult } from "../../api";
import type { Command } from "./commands";

export type GroupName = "Tabs" | "Commands" | "Bookmarks" | "History";
export type Entry = {
  readonly key: string;
  readonly group: GroupName;
  readonly title: string;
  /** The URL host, for tabs, history and bookmarks. */
  readonly host?: string;
  readonly shortcut?: string;
  readonly run: CommandBarItem;
};

export const GROUP_ORDER: readonly GroupName[] = ["Tabs", "Commands", "Bookmarks", "History"];
const GROUP_OF: Readonly<Record<CommandBarKind, GroupName>> = { tab: "Tabs", bookmark: "Bookmarks", history: "History" };

export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}

function fromResult(r: CommandBarResult, i: number): Entry {
  const run: CommandBarItem = r.kind === "tab" ? { kind: "tab", tabId: r.tabId } : { kind: r.kind, url: r.url };
  return { key: `${r.kind}-${r.tabId ?? r.url}-${i}`, group: GROUP_OF[r.kind], title: r.title || r.url, host: hostOf(r.url), run };
}

function fromCommand(c: Command): Entry {
  return { key: `command-${c.id}`, group: "Commands", title: c.title, shortcut: c.shortcut, run: { kind: "command", id: c.id } };
}

/** Rows grouped Tabs, Commands, Bookmarks, History; each group keeps the order it came in. */
export function buildEntries(results: readonly CommandBarResult[], commands: readonly Command[]): readonly Entry[] {
  const all = [...results.map(fromResult), ...commands.map(fromCommand)];
  return GROUP_ORDER.flatMap((g) => all.filter((e) => e.group === g));
}
