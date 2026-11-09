/** Settings sections and the search index. A test checks every anchor here exists on its page. */

export const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "models", label: "Models" },
  { id: "skills", label: "Skills and MCP" },
  { id: "permissions", label: "Permissions" },
  { id: "privacy", label: "Privacy and security" },
  { id: "performance", label: "Performance" },
  { id: "sync", label: "Sync" },
  { id: "builtin", label: "Built-in extensions" },
  { id: "memory", label: "Memory" },
  { id: "routines", label: "Routines" },
  { id: "import", label: "Import" },
  { id: "about", label: "About and updates" },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];

export const isSection = (s: string): s is SectionId => SECTIONS.some((x) => x.id === s);
export const sectionLabel = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.label;

export type SearchEntry = { readonly section: SectionId; readonly anchor: string; readonly title: string; readonly words?: string };

export const SEARCH_INDEX: readonly SearchEntry[] = [
  { section: "appearance", anchor: "theme", title: "Theme", words: "ink graphite dusk paper contrast dark light colour color" },
  { section: "appearance", anchor: "accent", title: "Accent colour", words: "blue teal amber rose mono color" },
  { section: "appearance", anchor: "match-system", title: "Match system", words: "dark mode light mode automatic macos" },
  { section: "appearance", anchor: "hide-chrome", title: "Hide tab strip and bookmarks bar", words: "chrome bars fullscreen minimal" },
  { section: "appearance", anchor: "reveal-on-hover", title: "Show the bars at the top edge", words: "hover reveal" },
  { section: "appearance", anchor: "density", title: "Density", words: "compact comfortable rows" },
  { section: "models", anchor: "providers", title: "Model providers", words: "sign in claude chatgpt codex grok openai anthropic gemini openrouter ollama lm studio api key" },
  { section: "models", anchor: "task-models", title: "Task models", words: "default fast standard deep visual image generation effort" },
  { section: "skills", anchor: "mcp-servers", title: "MCP servers", words: "tools mcp stdio http sse" },
  { section: "skills", anchor: "mcp-import", title: "Import MCP servers", words: "claude code codex claude desktop cursor grok" },
  { section: "skills", anchor: "skills-list", title: "Skills", words: "skill.md site skills built-in" },
  { section: "permissions", anchor: "permission-mode", title: "Permission mode", words: "ask guard skip confirmation approval" },
  { section: "permissions", anchor: "site-rules", title: "Site rules", words: "always allow always ask never touch bank" },
  { section: "permissions", anchor: "client-rules", title: "Outside agents", words: "mcp cli clients claude code codex" },
  { section: "permissions", anchor: "audit-log", title: "Activity log", words: "audit log actions history approved export" },
  { section: "privacy", anchor: "content-blocker", title: "Block ads and trackers", words: "content blocker adblock easylist easyprivacy" },
  { section: "privacy", anchor: "cookie-banners", title: "Reject cookie banners", words: "consent gdpr" },
  { section: "privacy", anchor: "tracking-params", title: "Remove tracking parameters", words: "utm fbclid gclid links" },
  { section: "privacy", anchor: "https-only", title: "HTTPS-only", words: "secure connections" },
  { section: "privacy", anchor: "doh", title: "Encrypted DNS", words: "dns over https doh cloudflare quad9 mullvad" },
  { section: "privacy", anchor: "fingerprinting", title: "Block ad-targeting APIs", words: "fingerprinting topics protected audience fledge ad measurement privacy sandbox" },
  { section: "privacy", anchor: "third-party-cookies", title: "Block third-party cookies", words: "cookies tracking" },
  { section: "privacy", anchor: "background-connections", title: "Background connections", words: "network updates safe browsing widevine" },
  { section: "privacy", anchor: "backup-export", title: "Export everything", words: "backup encrypted export file new mac migrate secure enclave keys" },
  { section: "privacy", anchor: "backup-restore", title: "Restore from recovery key", words: "restore backup recovery key new mac migration assistant unlock" },
  { section: "privacy", anchor: "site-data", title: "Site data", words: "cookies storage forget clear" },
  { section: "performance", anchor: "memory-saver", title: "Sleep tabs you aren't using", words: "memory saver lulltab sleep discard idle timeout ram" },
  { section: "performance", anchor: "never-sleep", title: "Never sleep these sites", words: "whitelist exceptions keep awake lulltab" },
  { section: "performance", anchor: "tab-memory", title: "Memory by tab", words: "ram usage memory tabs" },
  { section: "sync", anchor: "sync-on", title: "Sync this Mac", words: "sync devices bookmarks history open tabs pair qr code account" },
  { section: "sync", anchor: "sync-devices", title: "Synced devices", words: "sync devices remove mac" },
  { section: "privacy", anchor: "recovery-key", title: "Recovery key", words: "sync recovery key touch id lost device restore" },
  { section: "builtin", anchor: "built-in-perch", title: "Perch tools", words: "extension ad blocker reader view link preview screenshots" },
  { section: "builtin", anchor: "built-in-backrow", title: "Backrow", words: "extension watch party netflix youtube" },
  { section: "builtin", anchor: "built-in-caveatly", title: "Caveatly", words: "extension terms of service privacy policy" },
  { section: "memory", anchor: "memory-extraction", title: "Learn from chats", words: "memory extraction facts" },
  { section: "memory", anchor: "history-extraction", title: "Learn from browsing history", words: "memory history" },
  { section: "memory", anchor: "dreaming", title: "Tidy memory overnight", words: "dreaming consolidate" },
  { section: "memory", anchor: "dream-log", title: "Overnight tidy log", words: "dreaming dream log merged" },
  { section: "memory", anchor: "memory-wipe", title: "Delete all memory", words: "wipe erase" },
  { section: "routines", anchor: "routines-list", title: "Routines", words: "schedule automate recurring" },
  { section: "import", anchor: "import-browsers", title: "Import from another browser", words: "chrome safari arc aside firefox bookmarks passwords" },
  { section: "about", anchor: "version", title: "Perch version", words: "chromium about" },
  { section: "about", anchor: "auto-update", title: "Update automatically", words: "updates sparkle" },
];

export function searchSettings(query: string): readonly SearchEntry[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  return SEARCH_INDEX.filter((e) => {
    const hay = `${e.title} ${e.words ?? ""} ${sectionLabel(e.section)}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
