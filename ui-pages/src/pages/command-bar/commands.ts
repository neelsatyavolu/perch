/**
 * Commands the command bar offers, matched in the page. The browser maps each id to its own
 * command, so the ids are a contract with the overlay: change one only together with it.
 */

export type Command = { readonly id: string; readonly title: string; readonly keywords?: readonly string[]; readonly shortcut?: string };

export const COMMANDS: readonly Command[] = [
  { id: "new-tab", title: "New tab", shortcut: "⌘T" },
  { id: "new-window", title: "New window", shortcut: "⌘N" },
  { id: "new-incognito-window", title: "New incognito window", keywords: ["private"], shortcut: "⇧⌘N" },
  { id: "close-duplicate-tabs", title: "Close duplicate tabs", keywords: ["dedupe", "tidy"] },
  { id: "close-tabs-older-than-day", title: "Close tabs older than a day", keywords: ["old", "stale", "tidy"] },
  { id: "sleep-tab", title: "Sleep this tab", keywords: ["memory", "suspend", "discard"], shortcut: "⌥⇧S" },
  { id: "hide-chrome", title: "Hide browser chrome", keywords: ["toolbar", "focus", "full screen"], shortcut: "⇧⌘\\" },
  { id: "copy-url", title: "Copy URL", keywords: ["link", "address"], shortcut: "⇧⌘C" },
  { id: "copy-url-markdown", title: "Copy URL as Markdown", keywords: ["link", "address"], shortcut: "⌥⇧⌘C" },
  { id: "open-settings", title: "Open settings", keywords: ["preferences", "options"] },
  { id: "open-history", title: "Open history", shortcut: "⌘Y" },
  { id: "open-downloads", title: "Open downloads", shortcut: "⌥⌘L" },
  { id: "open-bookmarks", title: "Open bookmarks", keywords: ["favourites", "favorites"], shortcut: "⌥⌘B" },
  { id: "open-extensions", title: "Open extensions", keywords: ["add-ons", "plugins"] },
];

/** How many commands an empty command bar shows under the open tabs. */
export const EMPTY_QUERY_COMMANDS = 4;

/** Case-insensitive: every word of the query is a substring of the title or a keyword. */
export function matchCommands(text: string, commands: readonly Command[] = COMMANDS): readonly Command[] {
  const words = text.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return commands.slice(0, EMPTY_QUERY_COMMANDS);
  return commands.filter((c) => {
    const hay = [c.title, ...(c.keywords ?? [])].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}
