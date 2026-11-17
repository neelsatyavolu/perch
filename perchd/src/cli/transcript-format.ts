/** `perch transcript`: a chat's debug transcript as a readable timeline. */

import type { TranscriptRecord } from "../agent/debug-transcript";

const indent = (text: string) => text.replace(/\n/g, "\n    ");
const clock = (iso: string) => iso.slice(11, 19);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function line(e: TranscriptRecord): string {
  switch (e.kind) {
    case "run":
      return `RUN ${e.runId} · ${e.model} · ${e.mode}${e.effort ? ` · ${e.effort}` : ""}\n    ${indent(e.task)}`;
    case "turn": {
      const usage = e.usage ? ` · ${e.usage.input} in / ${e.usage.output} out` : "";
      const calls = e.calls.map((c) => `\n    → ${c.name} ${JSON.stringify(c.args)}`).join("");
      const text = e.text.trim() ? `\n    ${indent(e.text.trim())}` : "";
      return `MODEL ${secs(e.ms)}${usage}${e.error ? ` · ERROR ${e.error}` : ""}${text}${calls}`;
    }
    case "tool": {
      const approved = e.approved === null ? "" : e.approved ? " · approved" : " · declined";
      const image = e.imageBytes ? ` · image ${Math.round(e.imageBytes / 1024)} KB` : "";
      return `TOOL ${e.name} ${secs(e.ms)}${approved}${e.error ? " · ERROR" : ""}${image}\n    ${indent(e.content)}`;
    }
    case "step":
      return `STEP ${e.label}${e.detail ? ` (${e.detail})` : ""}`;
    case "output":
      return `OUTPUT\n    ${indent(e.output)}`;
    case "approval":
      return `APPROVAL ${e.approved ? "allowed" : "not allowed"}: ${e.label}`;
    case "end":
      return `END ${e.outcome} after ${secs(e.ms)}\n    ${indent(e.text)}`;
  }
}

export function formatTranscript(title: string, chatId: string, events: TranscriptRecord[]): string {
  if (!events.length) return `${title} (${chatId}): nothing recorded yet. Runs are recorded from this version on and kept 30 days.\n`;
  return `${title} (${chatId})\n\n${events.map((e) => `${clock(e.time)} ${line(e)}`).join("\n")}\n`;
}

export function formatTranscriptList(chats: { id: string; title: string; updatedAt: string }[]): string {
  if (!chats.length) return "No chats yet.\n";
  return `${chats.map((c) => `${c.id}  ${c.updatedAt.slice(0, 16).replace("T", " ")}  ${c.title}`).join("\n")}\n`;
}
