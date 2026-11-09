/**
 * Normalised import data. Every reader returns these shapes; every writer takes them.
 * Times are Unix milliseconds. Everything is read-only: readers build new values, never patch.
 */

export const DATA_TYPES = [
  "bookmarks",
  "history",
  "tabs",
  "searchEngines",
  "passwords",
  "addresses",
  "cookies",
  "extensions",
  "memory",
  "skills",
  "chats",
] as const;
export type DataType = (typeof DATA_TYPES)[number];

/** Types selected unless the user changes them. Cookies are never on by default. */
export const DEFAULT_TYPES: readonly DataType[] = DATA_TYPES.filter((t) => t !== "cookies");

export function isDataType(value: unknown): value is DataType {
  return typeof value === "string" && (DATA_TYPES as readonly string[]).includes(value);
}

export type BookmarkUrl = { readonly kind: "url"; readonly title: string; readonly url: string; readonly added?: number };
export type BookmarkFolder = { readonly kind: "folder"; readonly title: string; readonly children: readonly BookmarkNode[]; readonly added?: number };
export type BookmarkNode = BookmarkUrl | BookmarkFolder;
/** The three Chromium roots. Safari's menu and Firefox's menu land in "other". */
export type Bookmarks = { readonly bar: readonly BookmarkNode[]; readonly other: readonly BookmarkNode[]; readonly mobile: readonly BookmarkNode[] };

export type HistoryEntry = { readonly url: string; readonly title: string; readonly visitCount: number; readonly typedCount: number; readonly lastVisit: number };

export type TabGroup = { readonly id: string; readonly title: string; readonly color: string; readonly collapsed: boolean };
export type SessionTab = { readonly url: string; readonly title: string; readonly pinned: boolean; readonly groupId?: string };
export type SessionWindow = { readonly tabs: readonly SessionTab[]; readonly selected: number; readonly groups: readonly TabGroup[] };

export type SearchEngine = { readonly name: string; readonly keyword: string; readonly url: string; readonly suggestUrl?: string; readonly isDefault: boolean };

export type Password = { readonly url: string; readonly signonRealm: string; readonly username: string; readonly password: string; readonly created?: number; readonly note?: string };

export type Address = {
  readonly name: string;
  readonly organization: string;
  readonly street: string;
  readonly city: string;
  readonly state: string;
  readonly zip: string;
  readonly country: string;
  readonly phone: string;
  readonly email: string;
};

export type Cookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  /** Unix seconds; undefined for a session cookie. */
  readonly expires?: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: "Strict" | "Lax" | "None";
  /** A partitioned (CHIPS) cookie: the top-level site it belongs to, and whether it was set in a cross-site frame. */
  readonly partition?: { readonly site: string; readonly crossSite: boolean };
};

export type Extension = { readonly id: string; readonly name: string; readonly version: string; readonly storeUrl?: string };

/** A markdown file from Aside's memory or skills, path relative to its root. */
export type TextFile = { readonly path: string; readonly text: string };
export type ChatTurn = { readonly user: string; readonly assistant: string; readonly at: number };
export type Chat = { readonly id: string; readonly title: string; readonly created: number; readonly turns: readonly ChatTurn[] };

export type ImportData = {
  readonly bookmarks?: Bookmarks;
  readonly history?: readonly HistoryEntry[];
  readonly tabs?: readonly SessionWindow[];
  readonly searchEngines?: readonly SearchEngine[];
  readonly passwords?: readonly Password[];
  readonly addresses?: readonly Address[];
  readonly cookies?: readonly Cookie[];
  readonly extensions?: readonly Extension[];
  readonly memory?: readonly TextFile[];
  readonly skills?: readonly TextFile[];
  readonly chats?: readonly Chat[];
};

/** A reader's per-type outcome: the count it can import, or why it cannot. */
export type Availability = { readonly count: number } | { readonly unavailable: string };
export type Counts = Partial<Record<DataType, Availability>>;

export class ImportError extends Error {
  constructor(
    message: string,
    readonly reason: "full-disk-access" | "keychain-denied" | "not-found" | "unreadable" | "browser-open" | "invalid",
  ) {
    super(message);
  }
}

export function countBookmarks(nodes: readonly BookmarkNode[]): number {
  return nodes.reduce((n, node) => n + (node.kind === "url" ? 1 : countBookmarks(node.children)), 0);
}

export function isWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}
