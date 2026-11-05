/**
 * The task text for one turn of a chat. The agent loop takes a single task, so earlier turns,
 * the tab the user is looking at and the artifact format travel inside it.
 */

import type { ChatMessage, Scope, TabInfo } from "./protocol";

export const ARTIFACT_FORMAT = [
  "If the user would want to keep what you make (a page, document, chart, table, code file or data), give it as an artifact:",
  'a fenced block that opens with ```artifact <kind> "<title>" and closes with ```. Kinds: html, markdown, code:<language>, svg, csv, json.',
  "Use a longer fence (````) when the content contains ```. Using the same title again saves a new version.",
].join("\n");

const MAX_TURN = 2_000;
const MAX_HISTORY = 24_000;

export type TaskInput = { history: ChatMessage[]; text: string; scope: Scope; tab?: TabInfo; tabs: TabInfo[] };

export function buildTask(input: TaskInput): string {
  const parts: string[] = [];
  const earlier = earlierTurns(input.history);
  if (earlier) parts.push(`Earlier in this chat:\n${earlier}`);
  const tabs = tabContext(input);
  if (tabs) parts.push(tabs);
  parts.push(ARTIFACT_FORMAT);
  parts.push(earlier || tabs ? `Now the user asks:\n${input.text}` : input.text);
  return parts.join("\n\n");
}

function earlierTurns(history: ChatMessage[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const m of [...history].reverse()) {
    const text = m.text.length > MAX_TURN ? `${m.text.slice(0, MAX_TURN)}…` : m.text;
    const line = `${m.role === "user" ? "User" : "Perch"}: ${text.replace(/\n+/g, " ")}`;
    if (size + line.length > MAX_HISTORY) break;
    lines.unshift(line);
    size += line.length;
  }
  return lines.join("\n");
}

function tabContext(input: TaskInput): string {
  const line = (t: TabInfo) => `- ${oneLine(t.title) || "(untitled)"} (${oneLine(t.url)})`;
  if (input.scope === "current" && input.tab) {
    return `The user is looking at this tab, which you may open and use:\n${line(input.tab)}`;
  }
  if (input.scope === "all" && input.tabs.length) {
    return `The user's open tabs, which you may open and use:\n${input.tabs.slice(0, 50).map(line).join("\n")}`;
  }
  return "";
}

function oneLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").slice(0, 300);
}
