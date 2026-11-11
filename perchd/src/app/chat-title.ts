/**
 * A chat's name, written by the profile's fast model after the first reply, like the titles in
 * Aside's chat list ("Compare SFO to HND fares"). Until then, and whenever the model can't be
 * reached, a chat is named after the start of its first message.
 */

import { askForTool } from "../memory/model-call";
import type { Model, ToolSpec } from "../models/types";

const MAX_TITLE = 60;
const MAX_INPUT = 2_000;

const TOOL: ToolSpec = {
  name: "set_title",
  description: "Set the chat's title.",
  parameters: {
    type: "object",
    properties: { title: { type: "string", description: "Two to six words, sentence case, no quotes or trailing punctuation." } },
    required: ["title"],
    additionalProperties: false,
  },
};

const SYSTEM =
  "You name chats in a browser's chat list. Read the user's first message and the reply, then call set_title with a short title " +
  "of two to six words in sentence case that says what the chat is about, such as \"Compare SFO to HND fares\" or " +
  "\"Find a pair of chinos\". No quotes, no emoji, no trailing period.";

/** The name a chat starts with: the start of its first message, on one line. */
export function provisionalTitle(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_TITLE ? line : `${line.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

/** A title from untrusted model output, tidied; null when there is nothing usable. */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "")
    .replace(/[.!?:;,]+$/, "")
    .trim();
  if (!title) return null;
  return title.length <= MAX_TITLE ? title : `${title.slice(0, MAX_TITLE - 1).trimEnd()}…`;
}

const clip = (text: string) => (text.length > MAX_INPUT ? `${text.slice(0, MAX_INPUT)}…` : text);

export async function titleChat(model: Model, ask: string, reply: string, signal?: AbortSignal): Promise<string | null> {
  const user = `First message:\n${clip(ask)}\n\nReply:\n${clip(reply)}`;
  const answer = await askForTool(model, { system: SYSTEM, user, tool: TOOL }, signal);
  return cleanTitle(answer.args?.title) ?? cleanTitle(answer.text.split("\n")[0]);
}

const TITLE_LINE = /^\s*\**\s*title\s*:\s*\**\s*(.+?)\s*\**\s*(?:\n|$)/i;

/** The `Title: …` line an agent puts first in its first reply (transcript.ts TITLE_FORMAT), and the reply without it. */
export function takeTitleLine(text: string): { title: string | null; text: string } {
  const m = TITLE_LINE.exec(text);
  if (!m) return { title: null, text };
  return { title: cleanTitle(m[1]), text: text.slice(m[0].length).replace(/^\s*\n/, "").trimStart() };
}
