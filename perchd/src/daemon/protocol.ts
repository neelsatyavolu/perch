/**
 * Messages on perchd's socket. A client first says hello (who it is, its token, its session),
 * then sends requests. The daemon may ask a client to approve an action; the client answers.
 *
 *   client → daemon   hello · request · approval
 *   daemon → client   welcome · response · approve · error (then the socket closes)
 */

import { CLIENT_NAME } from "./keychain";

export type OnEnd = "close" | "sleep";

export type Hello = {
  type: "hello";
  client: string;
  token: string;
  /** Which of the client's sessions this is; tabs belong to a session. */
  session: string;
  title: string;
  /** The agent's name for the tab group, like "Claude Code". */
  agent: string;
  /** A session that ends when this connection closes (MCP), rather than one kept between commands (CLI). */
  persistent: boolean;
  onEnd: OnEnd;
  /** Whether this connection can answer approval requests. */
  interactive: boolean;
};

export type Request = { type: "request"; id: number; method: string; params: Record<string, unknown> };
export type ApprovalReply = { type: "approval"; id: number; approved: boolean };

export type Welcome = { type: "welcome"; client: string; session: string; label: string; mode: string };
export type Response = { type: "response"; id: number; result?: unknown; error?: string };
export type ApproveAsk = { type: "approve"; id: number; summary: string; kind: string; site: string };
export type Fatal = { type: "error"; error: string };
/** Something the person at the terminal should know while a request waits, such as a card in Perch. */
export type Notice = { type: "notice"; text: string };

export const SESSION_ID = /^[A-Za-z0-9._:-]{1,80}$/;
const TITLE_LIMIT = 80;

/** Known agents by client name or MCP clientInfo name, for tab group labels. */
const AGENTS: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude Code",
  "claude-ai": "Claude",
  codex: "Codex",
  "codex-mcp-client": "Codex",
  grok: "Grok",
  "grok-cli": "Grok",
  agterm: "agterm",
  agmux: "agmux",
  cli: "Terminal",
  flint: "Flint",
};

export function agentName(raw: string | undefined, client: string): string {
  const key = (raw ?? "").trim();
  if (key && AGENTS[key.toLowerCase()]) return AGENTS[key.toLowerCase()]!;
  if (key) return cleanText(key, 40);
  return AGENTS[client] ?? client;
}

/** Strips control characters and trims to a length. */
export function cleanText(text: string, limit = TITLE_LIMIT): string {
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

export function groupLabel(agent: string, title: string): string {
  return title ? `${agent} · ${title}` : agent;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Checks a hello at the boundary; returns the message to send back when it is not valid. */
export function parseHello(value: unknown): Hello | string {
  if (!isObject(value) || value.type !== "hello") return "Say hello first.";
  const client = String(value.client ?? "");
  if (!CLIENT_NAME.test(client)) return 'Client names use lowercase letters, digits and dashes, like "claude-code".';
  if (typeof value.token !== "string" || !value.token) return "A client token is required.";
  const session = value.session === undefined ? "default" : String(value.session);
  if (!SESSION_ID.test(session)) return "Session ids use letters, digits, dots, dashes, colons and underscores, up to 80 characters.";
  const onEnd = value.onEnd === undefined ? "close" : value.onEnd;
  if (onEnd !== "close" && onEnd !== "sleep") return 'onEnd must be "close" or "sleep".';
  return {
    type: "hello",
    client,
    token: value.token,
    session,
    title: cleanText(typeof value.title === "string" ? value.title : ""),
    agent: agentName(typeof value.agent === "string" ? value.agent : undefined, client),
    persistent: value.persistent === true,
    onEnd,
    interactive: value.interactive === true,
  };
}

export function parseClientMessage(value: unknown): Request | ApprovalReply | string {
  if (!isObject(value)) return "Messages are JSON objects.";
  if (value.type === "approval" && typeof value.id === "number") return { type: "approval", id: value.id, approved: value.approved === true };
  if (value.type !== "request") return "Unknown message type.";
  if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) return "A request needs a numeric id.";
  if (typeof value.method !== "string" || !value.method) return "A request needs a method.";
  if (value.params !== undefined && !isObject(value.params)) return "params must be an object.";
  return { type: "request", id: value.id, method: value.method, params: (value.params as Record<string, unknown>) ?? {} };
}
