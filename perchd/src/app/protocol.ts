/**
 * The app API's shapes, shared by perchd and Perch's pages in ui/. Types only, no imports, so the
 * UI can import this file without pulling in any daemon code.
 */

export type Mode = "ask" | "guard" | "skip";
/** Reasoning effort, lowest first; each model lists the ones it takes (ultra is Codex only). */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
/** Which tabs the agent may use: the tab the chat is in, every open tab, or only its own new tabs. */
export type Scope = "current" | "all" | "agent";
export type ChatStatus = "idle" | "running" | "waiting";

/** A tab as the browser reports it. */
export type TabInfo = {
  id: string;
  windowId: string;
  title: string;
  url: string;
  /** The tab's CDP target id, sent by the browser only; pages never set it. */
  targetId?: string;
  /** A private (incognito) window's tab, as the browser reports it (spec 5.8). */
  incognito?: boolean;
  /** The site's icon as a `data:image/png;base64,` URL, from the browser. */
  favicon?: string;
};
/** The tab a side chat belongs to. */
export type TabRef = { id: string; windowId: string };

export type ChatSettings = { mode: Mode; model: string; effort: Effort; scope: Scope };

/**
 * One thing the agent did in a run. `detail`: the code, query or URL the step ran (never what was
 * typed into a page); `output`: what came back, shortened.
 */
export type Step = { label: string; detail?: string; output?: string };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  /** Markdown. Artifacts appear as `[[artifact:<id>]]` on a line of their own. */
  text: string;
  time: string;
  /** The tab the user was looking at when they sent it. */
  context?: TabInfo;
  /** Files the user attached, by name; their paths stay in perchd. */
  attachments?: { id: string; name: string }[];
  /** Tabs the user named with @. */
  mentions?: TabInfo[];
  steps?: Step[];
  /** A message the chat sent itself at a scheduled time (scheduled.ts), not typed just now. */
  scheduled?: true;
  artifacts?: string[];
  error?: string;
  stopped?: boolean;
};

export type Chat = {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  settings: ChatSettings;
  messages: ChatMessage[];
  /** Set for a side chat: it shows only while this tab is active, in this tab's window. */
  tab: TabRef | null;
  draft: string;
  scrollTop: number;
  branchOf?: { chatId: string; messageId: string };
  /**
   * A private chat (spec 5.8): it began in an incognito tab, runs without memory, is never
   * written to disk, and is deleted when the last private window closes.
   */
  incognito?: true;
  /** The outside client (`perch exec`) that started this chat; only that client can see or steer it. */
  origin?: string;
  /** Messages the chat sends itself later (scheduled.ts). */
  scheduled?: ScheduledMessage[];
  /** Kept at the top of the chat lists. */
  pinned?: true;
  /** When the user last had this chat on screen; a reply after it is unread. */
  readAt?: string;
};

/** `preapproved`: the user approved it up front, so its run doesn't ask before sends, posts and publishing. */
export type ScheduledMessage = { id: string; at: string; text: string; preapproved?: true };

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
  tab: TabRef | null;
  status: ChatStatus;
  preview: string;
  pinned?: true;
  /** The last reply came after the user last looked at the chat. */
  unread?: true;
  /** The last reply was an error. */
  failed?: true;
};

export type ArtifactKind = "html" | "markdown" | "code" | "svg" | "csv" | "json" | "image";

export type ArtifactMeta = {
  id: string;
  chatId: string;
  title: string;
  kind: ArtifactKind;
  language?: string;
  version: number;
  versions: number;
  updatedAt: string;
  /** The version's address on the isolated artifact origin. */
  url: string;
};

export type ApprovalCard = {
  id: string;
  chatId: string;
  runId: string;
  /** What will happen, in a short sentence: `Click button "Send"`. */
  title: string;
  site: string;
  kind: "change" | "risky" | "payment";
  /** The exact text that goes out, when there is one. */
  body?: string;
  fields?: { label: string; value: string }[];
  /** The confirm button's label names the action: "Send", "Pay $42.18". Never "OK" or "Confirm". */
  confirm: string;
  danger: boolean;
};

export type ModelInfo = { id: string; label: string; provider: string; efforts: Effort[] };

export type AppInfo = { models: ModelInfo[]; defaults: ChatSettings; artifactOrigin: string };

export type WindowState = { windowId: string; tab: TabInfo | null; chatId: string | null };

export type AppEvent =
  | { type: "chat.updated"; chat: ChatSummary }
  | { type: "chat.removed"; chatId: string }
  | { type: "run.started"; chatId: string; runId: string; message: ChatMessage }
  | { type: "run.text"; chatId: string; runId: string; delta: string }
  | { type: "run.step"; chatId: string; runId: string; label: string; detail?: string }
  /** What the run's latest step returned. */
  | { type: "run.step.output"; chatId: string; runId: string; output: string }
  | { type: "run.approval"; chatId: string; runId: string; card: ApprovalCard }
  | { type: "run.approval.resolved"; chatId: string; runId: string; approvalId: string; approved: boolean }
  | { type: "run.finished"; chatId: string; runId: string; message: ChatMessage }
  | { type: "artifact.saved"; chatId: string; artifact: ArtifactMeta }
  | { type: "window.active"; state: WindowState }
  /** What new chats start with changed: a pick in any composer, or Settings → Models. */
  | { type: "defaults"; defaults: ChatSettings }
  /** For Perch's own pages (ui-pages): `job:<id>` carries a job's progress; `appearance` the theme. */
  | { type: "pages.event"; event: string; data: unknown };

/** A run in progress, for a page that opens while it runs. */
/** `startedAt`: when the run began, for the chat's "Working for…" clock. */
export type RunSnapshot = { runId: string; chatId: string; text: string; steps: Step[]; approval: ApprovalCard | null; startedAt?: string };
