/** Plain words for the values in api.ts, shared by the pages and the fake backend. */

import type {
  Effort, FactGroup, ImportKind, ImportNeed, McpImportSource, PermissionMode, Schedule, SiteRuleKind, TaskRole, Weekday,
} from "../api";

export const IMPORT_KINDS: Readonly<Record<ImportKind, { label: string; noun: string }>> = {
  tabs: { label: "Open tabs and windows", noun: "tabs" },
  bookmarks: { label: "Bookmarks", noun: "bookmarks" },
  history: { label: "History", noun: "history entries" },
  passwords: { label: "Passwords", noun: "passwords" },
  cookies: { label: "Cookies and logins", noun: "sites with logins" },
  extensions: { label: "Extensions", noun: "extensions" },
  settings: { label: "Search engine and settings", noun: "settings" },
  "aside-memory": { label: "Aside memory", noun: "memory pages" },
  "aside-skills": { label: "Aside skills", noun: "skills" },
  "aside-chats": { label: "Aside chats", noun: "chats" },
  "aside-preferences": { label: "Permission mode and model choices", noun: "preferences" },
};

export const IMPORT_NEEDS: Readonly<Record<ImportNeed, string>> = {
  "full-disk-access": "Needs Full Disk Access",
  keychain: "macOS asks to unlock this browser's Keychain item",
  "csv-export": "Export a CSV from the Passwords app first",
  "primary-password": "Asks for your primary password",
};

export const MCP_SOURCES: Readonly<Record<McpImportSource | "manual", string>> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  grok: "Grok",
  manual: "added by you",
};

export const MODES: Readonly<Record<PermissionMode, { label: string; detail: string }>> = {
  ask: { label: "Ask", detail: "Every action that changes something waits for you. Reading and navigating don't." },
  guard: { label: "Guard", detail: "Reads, searches and fills forms freely. Asks before it sends, posts, buys, books, deletes or shares." },
  skip: { label: "Skip confirmation", detail: "Runs without asking. Payments, purchases and password changes still wait for you." },
};

export const SITE_RULES: Readonly<Record<SiteRuleKind, string>> = { allow: "Always allow", ask: "Always ask", never: "Never touch" };

export const ROLES: Readonly<Record<TaskRole, { label: string; detail: string }>> = {
  default: { label: "Default model", detail: "New chats. The last model you use becomes the default" },
  fast: { label: "Fast", detail: "Side work, summaries, memory extraction and dreaming" },
  standard: { label: "Standard", detail: "Subagents and memory reorganisation" },
  deep: { label: "Deep", detail: "Hard reasoning, planning, judging and synthesis" },
  visual: { label: "Visual", detail: "Screenshots and reading page images" },
  image: { label: "Image generation", detail: "Making and editing images in chats and artifacts" },
};

export const EFFORTS: readonly Effort[] = ["off", "low", "medium", "high", "max"];
export const EFFORT_LABELS: Readonly<Record<Effort, string>> = { off: "Off", low: "Low", medium: "Medium", high: "High", max: "Max" };

export const FACT_GROUPS: readonly { id: FactGroup; label: string }[] = [
  { id: "about", label: "About you" },
  { id: "people", label: "People" },
  { id: "places", label: "Places and accounts" },
  { id: "writing", label: "Writing style" },
  { id: "sites", label: "Sites" },
];

export const WEEKDAYS: readonly { id: Weekday; short: string; long: string }[] = [
  { id: "mon", short: "M", long: "Monday" },
  { id: "tue", short: "T", long: "Tuesday" },
  { id: "wed", short: "W", long: "Wednesday" },
  { id: "thu", short: "T", long: "Thursday" },
  { id: "fri", short: "F", long: "Friday" },
  { id: "sat", short: "S", long: "Saturday" },
  { id: "sun", short: "S", long: "Sunday" },
];

const WEEKDAY_SET = ["mon", "tue", "wed", "thu", "fri"].join();
const WEEKEND_SET = ["sat", "sun"].join();

export function describeSchedule(s: Schedule): string {
  if (s.kind === "interval") return s.hours === 1 ? "Every hour" : `Every ${s.hours} hours`;
  if (s.kind === "trigger") return `When ${s.event}`;
  const days = WEEKDAYS.filter((d) => s.days.includes(d.id)).map((d) => d.id);
  const key = days.join();
  const when =
    days.length === 7 ? "Every day" :
    key === WEEKDAY_SET ? "Weekdays" :
    key === WEEKEND_SET ? "Weekends" :
    days.length === 1 ? `${WEEKDAYS.find((d) => d.id === days[0])!.long}s` :
    days.map((d) => WEEKDAYS.find((w) => w.id === d)!.long.slice(0, 3)).join(", ");
  return `${when} ${s.time}`;
}

export function countOf(n: number, noun: string): string {
  return `${n.toLocaleString("en-US")} ${noun}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}
