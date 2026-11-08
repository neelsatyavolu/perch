/** Sample data for the fake backend. Every name, address and figure here is made up. */

import type {
  AboutInfo, AuditEntry, ChatSummary, CommandBarResult, DetectedBrowser, DraftFact, DreamLog, McpImportCandidate, McpServer, MemoryDoc, MemorySettings, Model,
  MemorySaverSettings, Permissions, PrivacySettings, Provider, Routine, RoutineProposal, SetupSource, SiteData, Skill, Suggestion, SyncStatus, TabMemory, TaskModel,
} from "../api";

export const SEED_NOW = "2026-11-05T09:46:00.000Z";

export const PROVIDERS: readonly Provider[] = [
  { id: "claude-code", name: "Claude", kind: "subscription", detail: "Subscription, through Claude Code on this Mac", state: "connected", account: "Claude Code 2.4" },
  { id: "chatgpt", name: "ChatGPT", kind: "subscription", detail: "Subscription, signs in through OpenAI", state: "connected", account: "neel@example.com" },
  { id: "grok", name: "Grok", kind: "subscription", detail: "Subscription, signs in through xAI", state: "signed-out" },
  { id: "anthropic", name: "Anthropic API", kind: "api-key", detail: "Pay per use with your own key", state: "signed-out" },
  { id: "openai", name: "OpenAI API", kind: "api-key", detail: "Pay per use with your own key", state: "signed-out" },
  { id: "gemini", name: "Google Gemini API", kind: "api-key", detail: "Pay per use with your own key", state: "signed-out" },
  { id: "openrouter", name: "OpenRouter", kind: "api-key", detail: "Many models through one key", state: "signed-out" },
  { id: "local", name: "Models on this Mac", kind: "local", detail: "Ollama, LM Studio or any OpenAI-compatible endpoint", state: "signed-out" },
];

export const MODELS: readonly Model[] = [
  { id: "claude-code:opus-5.5", label: "Opus 5.5", provider: "claude-code", vision: true, imageGeneration: false },
  { id: "claude-code:sonnet-5.5", label: "Sonnet 5.5", provider: "claude-code", vision: true, imageGeneration: false },
  { id: "chatgpt:gpt-6-astra", label: "GPT-6 Astra", provider: "chatgpt", vision: true, imageGeneration: false },
  { id: "chatgpt:gpt-6.1-sol", label: "GPT-6.1 Sol", provider: "chatgpt", vision: true, imageGeneration: false },
  { id: "chatgpt:gpt-6-luna", label: "GPT-6 Luna", provider: "chatgpt", vision: false, imageGeneration: false },
  { id: "chatgpt:images", label: "ChatGPT Images", provider: "chatgpt", vision: false, imageGeneration: true },
  { id: "grok:grok-5", label: "Grok 5", provider: "grok", vision: true, imageGeneration: false },
  { id: "grok:imagine", label: "Grok Imagine", provider: "grok", vision: false, imageGeneration: true },
];

export const TASK_MODELS: readonly TaskModel[] = [
  { role: "default", modelId: "claude-code:opus-5.5", effort: "high", fast: false },
  { role: "fast", modelId: "chatgpt:gpt-6-luna", effort: "low", fast: true },
  { role: "standard", modelId: "chatgpt:gpt-6.1-sol", effort: "medium", fast: false },
  { role: "deep", modelId: "claude-code:opus-5.5", effort: "max", fast: false },
  { role: "visual", modelId: "chatgpt:gpt-6.1-sol", effort: "medium", fast: false },
  { role: "image", modelId: "chatgpt:images", effort: "off", fast: false },
];

export const CHATS: readonly ChatSummary[] = [
  { id: "c1", title: "Reply to Maya about Thursday", snippet: "Thursday 3:00 to 4:00 is free, so I added it to your calendar. The reply is ready to send when you approve.", updatedAt: "2026-11-05T09:44:00.000Z", status: "waiting" },
  { id: "c2", title: "Subscriptions from receipts", snippet: "9 active subscriptions, $112.43 a month. Two look unused: Cloud Notes and a second Music account.", updatedAt: "2026-11-04T18:10:00.000Z", status: "idle" },
  { id: "c3", title: "Compare SFO to HND fares", snippet: "Cheapest nonstop is $684 on Northwind for Dec 18 to Jan 2. Prices dropped $41 since Tuesday.", updatedAt: "2026-11-02T15:30:00.000Z", status: "idle" },
  { id: "c4", title: "Summarise Priya's notes", snippet: "Three decisions and two open questions from Monday's planning notes.", updatedAt: "2026-10-31T11:00:00.000Z", status: "idle" },
  { id: "c5", title: "Find the Backrow party link", snippet: "The Saturday watch party link is in Jordan's message from Oct 28.", updatedAt: "2026-10-29T20:15:00.000Z", status: "idle" },
];

export const SETUP_SUGGESTIONS: readonly Suggestion[] = [
  { id: "setup-memory", kind: "setup", title: "Set up your memory", detail: "Perch learns about you from the sources you choose, so you explain less.", icon: "memory", action: { type: "open", page: "memory" } },
  { id: "setup-routines", kind: "setup", title: "Find routines to automate", detail: "Perch looks for tasks you repeat and offers to run them on a schedule.", icon: "routines", action: { type: "open", page: "routines" } },
  { id: "setup-import", kind: "setup", title: "Import from another browser", detail: "Open tabs, bookmarks, passwords, and Aside's memory and skills.", icon: "import", action: { type: "open", page: "import" } },
];

export const TASK_SUGGESTIONS: readonly Suggestion[] = [
  { id: "task-mail", kind: "task", title: "Summarise unread mail", detail: "Grouped by what needs a reply today.", icon: "mail", action: { type: "ask", prompt: "Summarise my unread mail, grouped by what needs a reply today" } },
  { id: "task-week", kind: "task", title: "Plan my week", detail: "Calendar, deadlines and anything that clashes.", icon: "calendar", action: { type: "ask", prompt: "Plan my week: calendar, deadlines and anything that clashes" } },
  { id: "task-follow", kind: "task", title: "Find replies I owe", detail: "Threads where someone is waiting on you.", icon: "task", action: { type: "ask", prompt: "Find email threads where someone is waiting on my reply" } },
];

export const MCP_SERVERS: readonly McpServer[] = [
  { id: "m1", name: "consult", transport: "stdio", target: "consult-mcp --stdio", source: "claude-code", tools: 9, readOnlyTools: 4, trusted: false, enabled: true, secretNames: [] },
  { id: "m2", name: "context7", transport: "http", target: "https://mcp.context7.com/mcp", source: "codex", tools: 2, readOnlyTools: 2, trusted: false, enabled: true, secretNames: ["CONTEXT7_API_KEY"] },
  { id: "m3", name: "filesystem", transport: "stdio", target: "npx -y @modelcontextprotocol/server-filesystem ~/Documents", source: "claude-desktop", tools: 14, readOnlyTools: 6, trusted: false, enabled: false, secretNames: [] },
];

export const MCP_CANDIDATES: readonly McpImportCandidate[] = [
  { key: "claude-code:consult", name: "consult", source: "claude-code", configPath: "~/.claude.json", transport: "stdio", target: "consult-mcp --stdio", secretNames: [], alreadyAdded: true },
  { key: "claude-code:github", name: "github", source: "claude-code", configPath: "~/.claude.json", transport: "http", target: "https://api.githubcopilot.com/mcp/", secretNames: ["Authorization"], alreadyAdded: false },
  { key: "codex:linear", name: "linear", source: "codex", configPath: "~/.codex/config.toml", transport: "sse", target: "https://mcp.linear.app/sse?api_key=lin_api_0000000000example", secretNames: [], alreadyAdded: false },
  { key: "cursor:postgres", name: "postgres", source: "cursor", configPath: "~/.cursor/mcp.json", transport: "stdio", target: "npx -y @modelcontextprotocol/server-postgres", secretNames: ["DATABASE_URL"], alreadyAdded: false },
  { key: "grok:search", name: "web-search", source: "grok", configPath: "~/.grok/settings.json", transport: "stdio", target: "web-search-mcp", secretNames: ["SEARCH_API_KEY"], alreadyAdded: false },
];

export const SKILLS: readonly Skill[] = [
  { id: "s-gmail", name: "Gmail", description: "Read, search and draft mail through your signed-in session", origin: "built-in", enabled: true },
  { id: "s-calendar", name: "Google Calendar", description: "Read and add events", origin: "built-in", enabled: true },
  { id: "s-github", name: "GitHub", description: "Issues, pull requests and reviews", origin: "built-in", enabled: true },
  { id: "s-slack", name: "Slack", description: "Read channels and send messages", origin: "built-in", enabled: true },
  { id: "s-pdf", name: "PDF", description: "Read, fill and merge PDF files", origin: "built-in", enabled: true },
  { id: "s-notes", name: "infocus-show", description: "Edit an InFocus show recording", origin: "folder", location: "~/.claude/skills/infocus-show", enabled: true },
];

export const PERMISSIONS: Permissions = {
  mode: "guard",
  siteRules: [
    { id: "r1", pattern: "*.chase.com", rule: "never" },
    { id: "r2", pattern: "github.com", rule: "allow" },
  ],
  clientRules: [
    { id: "cli", client: "perch CLI", mode: "guard", lastUsed: "2026-11-05T08:10:00.000Z" },
    { id: "mcp-claude", client: "Claude Code (MCP)", mode: "guard", lastUsed: "2026-11-05T09:01:00.000Z" },
    { id: "mcp-codex", client: "Codex (MCP)", mode: "ask" },
  ],
  maxMode: null,
};

export const PRIVACY: PrivacySettings = {
  contentBlocker: true,
  cookieBanners: true,
  trackingParams: true,
  httpsOnly: true,
  dnsOverHttps: true,
  dohProvider: "cloudflare",
  dohCustomUrl: "",
  fingerprinting: true,
  thirdPartyCookies: "block",
  blockerExceptions: ["news.example.com"],
  backgroundConnections: [
    { id: "extensions", label: "Extension updates", detail: "From the Chrome Web Store", enabled: true },
    { id: "safe-browsing", label: "Safe Browsing lists", detail: "Hash-prefix list updates; no page addresses are sent", enabled: true },
    { id: "components", label: "Certificate and video components", detail: "CRLSets, certificate data and the Widevine module", enabled: true },
    { id: "filters", label: "Content blocker lists", detail: "EasyList and EasyPrivacy updates", enabled: true },
    { id: "updates", label: "Perch updates", detail: "One check a day on GitHub", enabled: true },
  ],
};

export const SITE_DATA: readonly SiteData[] = [
  { host: "mail.example.com", bytes: 48_200_000, cookies: 14, lastUsed: "2026-11-05T09:40:00.000Z" },
  { host: "github.com", bytes: 12_400_000, cookies: 9, lastUsed: "2026-11-05T08:30:00.000Z" },
  { host: "news.example.com", bytes: 3_100_000, cookies: 41, lastUsed: "2026-10-30T07:00:00.000Z" },
];

export const MEMORY_SAVER: MemorySaverSettings = {
  timeoutMinutes: 15,
  rules: [
    { kind: "domain", pattern: "music.example.com" },
    { kind: "host", pattern: "mail.example.com" },
  ],
};

export const TAB_MEMORY: readonly TabMemory[] = [
  { title: "Inbox (12) - Example Mail", url: "https://mail.example.com/inbox", bytes: 182_400_000, asleep: false },
  { title: "perch/ui-pages at main", url: "https://github.com/example/perch", bytes: 96_300_000, asleep: false },
  { title: "Quarterly plan - Example Docs", url: "https://docs.example.com/d/plan", bytes: 0, asleep: true },
  { title: "Weekend playlist", url: "https://music.example.com/playlist/7", bytes: 241_800_000, asleep: false },
  { title: "Morning headlines", url: "https://news.example.com/", bytes: 0, asleep: true },
];

export const OPEN_TABS: readonly CommandBarResult[] = [
  { kind: "tab", tabId: 101, title: "Inbox (12) - Example Mail", url: "https://mail.example.com/inbox" },
  { kind: "tab", tabId: 102, title: "perch/ui-pages at main", url: "https://github.com/example/perch" },
  { kind: "tab", tabId: 103, title: "Quarterly plan - Example Docs", url: "https://docs.example.com/d/plan" },
  { kind: "tab", tabId: 104, title: "Weekend playlist", url: "https://music.example.com/playlist/7" },
  { kind: "tab", tabId: 105, title: "Morning headlines", url: "https://news.example.com/" },
];

export const HISTORY: readonly CommandBarResult[] = [
  { kind: "history", title: "SFO to HND, 12 Dec - Example Flights", url: "https://flights.example.com/search?from=SFO&to=HND" },
  { kind: "history", title: "Preact hooks reference", url: "https://preactjs.com/guide/v10/hooks/" },
  { kind: "history", title: "Pull request 214: command bar - perch", url: "https://github.com/example/perch/pull/214" },
  { kind: "history", title: "Ramen near Hayes Valley - Example Maps", url: "https://maps.example.com/search/ramen" },
  { kind: "history", title: "Quarterly plan comments - Example Docs", url: "https://docs.example.com/d/plan/comments" },
  { kind: "history", title: "Weather this week", url: "https://weather.example.com/sf" },
];

export const BOOKMARKS: readonly CommandBarResult[] = [
  { kind: "bookmark", title: "Team calendar", url: "https://calendar.example.com/team" },
  { kind: "bookmark", title: "Perch issues", url: "https://github.com/example/perch/issues" },
  { kind: "bookmark", title: "Expense report form", url: "https://expenses.example.com/new" },
  { kind: "bookmark", title: "MDN Web Docs", url: "https://developer.mozilla.org/" },
];

export const MEMORY_SETTINGS: MemorySettings = { extraction: true, historyExtraction: false, dreaming: true, lastDream: "2026-11-05T03:00:00.000Z" };

export const MEMORY_DOCS: readonly MemoryDoc[] = [
  { path: "USER.md", title: "About you", body: "# About you\n\n- Goes by Neel\n- Builds Perch, agterm and Backrow\n", updatedAt: "2026-11-04T22:00:00.000Z" },
  { path: "MEMORY.md", title: "Rules for the agent", body: "# Rules\n\n- Ask before sending anything on my behalf\n", updatedAt: "2026-11-01T10:00:00.000Z" },
  { path: "people/maya-chen.md", title: "Maya Chen", body: "# Maya Chen\n\n## Current\n- Design reviews, prefers afternoons\n\n## History\n", updatedAt: "2026-11-05T09:44:00.000Z" },
  { path: "people/jordan-patel.md", title: "Jordan Patel", body: "# Jordan Patel\n\n## Current\n- Backrow watch parties on Saturdays\n", updatedAt: "2026-10-28T20:00:00.000Z" },
  { path: "sites/github.md", title: "GitHub", body: "# GitHub\n\n## Current\n- Account neelsatyavolu\n", updatedAt: "2026-10-20T12:00:00.000Z" },
  { path: "episodic/2026-11-04.md", title: "Nov 4", body: "# 2026-11-04\n\n- Compared fares for December\n", updatedAt: "2026-11-04T23:00:00.000Z" },
];

export const SETUP_SOURCES: readonly SetupSource[] = [
  { id: "history", name: "Browsing history", detail: "Last 90 days on this Mac", on: true, available: true },
  { id: "mail", name: "Mail", detail: "Signed in, read only", on: true, available: true },
  { id: "calendar", name: "Calendar", detail: "Signed in, read only", on: true, available: true },
  { id: "messages", name: "Messages", detail: "Needs Full Disk Access", on: false, available: false, needs: "full-disk-access" },
  { id: "chatgpt-memory", name: "ChatGPT memory", detail: "From your data export", on: false, available: true, needs: "export-file" },
  { id: "claude-memory", name: "Claude memory", detail: "From your data export", on: false, available: true, needs: "export-file" },
  { id: "grok-memory", name: "Grok memory", detail: "From your data export", on: false, available: true, needs: "export-file" },
  { id: "aside", name: "Aside memory", detail: "Import from ~/.aside", on: true, available: true },
  { id: "web", name: "Web search for your name", detail: "Off unless you turn it on", on: false, available: true },
];

export const DRAFT_FACTS: readonly DraftFact[] = [
  { id: "f1", group: "about", text: "Goes by Neel", source: "Mail" },
  { id: "f2", group: "about", text: "Builds Perch, agterm and Backrow", source: "Browsing history" },
  { id: "f3", group: "people", text: "Maya Chen: design reviews, prefers afternoons", source: "Mail" },
  { id: "f4", group: "people", text: "Jordan Patel: Backrow watch parties on Saturdays", source: "Mail" },
  { id: "f5", group: "places", text: "Flies Northwind; prefers aisle seats, nonstop", source: "Aside memory" },
  { id: "f6", group: "writing", text: "Short, direct replies; signs off with first name", source: "Mail" },
  { id: "f7", group: "writing", text: "No exclamation marks; asks one question at a time", source: "ChatGPT memory" },
  { id: "f8", group: "sites", text: "GitHub account neelsatyavolu", source: "Browsing history" },
];

export const DREAM_LOGS: readonly DreamLog[] = [
  { id: "d2", at: "2026-11-05T03:00:00.000Z", merged: 2, updated: 5, archived: 1, lines: ["Merged two pages about Maya Chen", "Merged “Backrow” into projects/backrow.md", "Moved the old Northwind seat preference to History", "Updated 5 facts in USER.md and people/"] },
  { id: "d1", at: "2026-11-04T03:00:00.000Z", merged: 0, updated: 2, archived: 0, lines: ["Updated 2 facts in sites/github.md"] },
];

export const AUDIT_LOG: readonly AuditEntry[] = [
  { id: "a5", at: "2026-11-05T09:31:00.000Z", client: "Perch", tab: "Inbox (3) - Mail", site: "mail.google.com", action: "Clicked Send on a reply to Maya Chen", outcome: "approved" },
  { id: "a4", at: "2026-11-05T09:30:00.000Z", client: "Perch", tab: "Inbox (3) - Mail", site: "mail.google.com", action: "Typed a reply", outcome: "ran" },
  { id: "a3", at: "2026-11-05T09:01:00.000Z", client: "Claude Code (MCP)", tab: "Pull requests · perch", site: "github.com", action: "Read the page", outcome: "ran" },
  { id: "a2", at: "2026-11-05T08:12:00.000Z", client: "perch CLI", tab: "Chase - Accounts", site: "secure.chase.com", action: "Open the page", outcome: "blocked" },
  { id: "a1", at: "2026-11-04T21:40:00.000Z", client: "Perch", tab: "Checkout - Northwind", site: "northwind.example", action: "Place order, $412.80", outcome: "declined" },
];

export const ROUTINES: readonly Routine[] = [
  { id: "rt1", title: "Morning mail summary", prompt: "Summarise new mail from teachers and the InFocus team, grouped by what needs a reply.", schedule: { kind: "daily", time: "08:00", days: ["mon", "tue", "wed", "thu", "fri"] }, enabled: true, lastRun: { at: "2026-11-05T16:00:00.000Z", outcome: "ok" }, nextRun: "2026-11-06T16:00:00.000Z" },
  { id: "rt2", title: "Week ahead", prompt: "Calendar for the next 7 days, deadlines from Schoology and anything that clashes.", schedule: { kind: "daily", time: "18:00", days: ["sun"] }, enabled: true, nextRun: "2026-11-09T02:00:00.000Z" },
  { id: "rt3", title: "Watch SFO to HND", prompt: "Check nonstop fares SFO to HND for Dec 18 to Jan 2 and tell me if one drops below $650.", schedule: { kind: "interval", hours: 12 }, enabled: false, lastRun: { at: "2026-11-02T15:30:00.000Z", outcome: "failed" } },
  { id: "rt4", title: "File invoices", prompt: "Save the invoice PDF to Documents/Invoices and add a row to the expense sheet.", schedule: { kind: "trigger", event: "mail-received", match: "invoice" }, enabled: true },
];

export const PROPOSALS: readonly RoutineProposal[] = [
  { id: "p1", title: "Friday expense report", prompt: "Collect this week's receipts from mail into the expense sheet.", schedule: { kind: "daily", time: "16:00", days: ["fri"] }, evidence: "You did this on 3 Fridays since Oct 10" },
  { id: "p2", title: "Check Canvas for new grades", prompt: "Open Canvas and list grades posted since yesterday.", schedule: { kind: "daily", time: "19:00", days: ["mon", "tue", "wed", "thu", "fri"] }, evidence: "You checked 9 times in the last 30 days" },
];

export const BROWSERS: readonly DetectedBrowser[] = [
  {
    id: "aside", name: "Aside", profiles: [{ id: "0", name: "Personal" }],
    options: [
      { kind: "tabs", available: true, count: 23 }, { kind: "bookmarks", available: true, count: 412 },
      { kind: "history", available: true }, { kind: "passwords", available: true, needs: "keychain" },
      { kind: "cookies", available: true, needs: "keychain" }, { kind: "extensions", available: true, count: 7 },
      { kind: "aside-memory", available: true, count: 186 }, { kind: "aside-skills", available: true, count: 4 },
      { kind: "aside-chats", available: true, count: 61 }, { kind: "aside-preferences", available: true },
    ],
  },
  {
    id: "chrome", name: "Chrome", profiles: [{ id: "Default", name: "Neel" }, { id: "Profile 1", name: "School" }],
    options: [
      { kind: "tabs", available: true, count: 41 }, { kind: "bookmarks", available: true, count: 1290 },
      { kind: "history", available: true }, { kind: "passwords", available: true, needs: "keychain" },
      { kind: "cookies", available: true, needs: "keychain" }, { kind: "extensions", available: true, count: 12 },
      { kind: "settings", available: true },
    ],
  },
  {
    id: "safari", name: "Safari", profiles: [{ id: "default", name: "Safari" }],
    options: [
      { kind: "tabs", available: true, needs: "full-disk-access" }, { kind: "bookmarks", available: true, count: 88 },
      { kind: "history", available: true, needs: "full-disk-access" }, { kind: "passwords", available: true, needs: "csv-export" },
      { kind: "cookies", available: true, needs: "full-disk-access" },
    ],
  },
];

export const ABOUT: AboutInfo = { version: "0.1.0", chromium: "157.0.8103.38", perchd: "0.1.0", channel: "stable", autoUpdate: true, lastChecked: "2026-11-05T07:00:00.000Z" };

export const SYNC_ON: SyncStatus = {
  on: true,
  lastSync: "2026-11-08T09:12:00.000Z",
  lastError: null,
  devices: [
    { id: "dev_mac", name: "MacBook Pro", kind: "browser", lastSeen: "2026-11-08T09:12:00.000Z", current: true },
    { id: "dev_studio", name: "Mac Studio", kind: "browser", lastSeen: "2026-11-07T18:40:00.000Z", current: false },
    { id: "dev_cli", name: "perch CLI on build box", kind: "cli", lastSeen: "2026-11-02T08:05:00.000Z", current: false },
  ],
};
export const SYNC_OFF: SyncStatus = { on: false, lastSync: null, lastError: null, devices: [] };
