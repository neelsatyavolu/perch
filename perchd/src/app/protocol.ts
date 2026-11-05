/**
 * The app API's shapes, shared by perchd and Perch's pages in ui/. Types only, no imports, so the
 * UI can import this file without pulling in any daemon code.
 */

export type Mode = "ask" | "guard" | "skip";
export type Effort = "low" | "medium" | "high";
/** Which tabs the agent may use: the tab the chat is in, every open tab, or only its own new tabs. */
export type Scope = "current" | "all" | "agent";
export type ChatStatus = "idle" | "running" | "waiting";

/** A tab as the browser reports it. */
export type TabInfo = { id: string; windowId: string; title: string; url: string };
/** The tab a side chat belongs to. */
export type TabRef = { id: string; windowId: string };

export type ChatSettings = { mode: Mode; model: string; effort: Effort; scope: Scope };

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  /** Markdown. Artifacts appear as `[[artifact:<id>]]` on a line of their own. */
  text: string;
  time: string;
  /** The tab the user was looking at when they sent it. */
  context?: TabInfo;
  steps?: string[];
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
};

export type ChatSummary = {
  id: string;
  title: string;
  updatedAt: string;
  tab: TabRef | null;
  status: ChatStatus;
  preview: string;
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
  | { type: "run.step"; chatId: string; runId: string; label: string }
  | { type: "run.approval"; chatId: string; runId: string; card: ApprovalCard }
  | { type: "run.approval.resolved"; chatId: string; runId: string; approvalId: string; approved: boolean }
  | { type: "run.finished"; chatId: string; runId: string; message: ChatMessage }
  | { type: "artifact.saved"; chatId: string; artifact: ArtifactMeta }
  | { type: "window.active"; state: WindowState };

/** A run in progress, for a page that opens while it runs. */
export type RunSnapshot = { runId: string; chatId: string; text: string; steps: string[]; approval: ApprovalCard | null };
