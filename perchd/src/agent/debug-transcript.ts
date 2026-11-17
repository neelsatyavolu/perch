/**
 * A debug transcript of one run: what was asked, each model turn, each tool call and what it
 * returned, approvals, errors and timings. Kept on disk sealed and compressed (app/debug-transcripts.ts)
 * so a run that went wrong can be read back with `perch transcript`. Never kept for incognito chats.
 */

/** Long tool results keep their start and end: enough to see what came back, small on disk. */
export const KEEP_HEAD = 6_000;
export const KEEP_TAIL = 2_000;

export type TranscriptEvent =
  | { kind: "run"; runId: string; task: string; model: string; mode: string; effort?: string; agent?: string }
  | { kind: "turn"; ms: number; text: string; calls: { id: string; name: string; args: unknown }[]; usage?: { input: number; output: number }; error?: string }
  | { kind: "tool"; id: string; name: string; ms: number; approved: boolean | null; error: boolean; content: string; imageBytes?: number }
  | { kind: "step"; label: string; detail?: string }
  | { kind: "output"; output: string }
  | { kind: "approval"; label: string; approved: boolean }
  | { kind: "end"; outcome: "final" | "error" | "cancelled"; text: string; ms: number };

export type TranscriptRecord = TranscriptEvent & { time: string };

/** Takes a run's events. Recording never throws and never waits on the disk. */
export type Transcript = { record(event: TranscriptEvent): void };

/** Keeps the start and end of a long text with a note of how much was left out. */
export function clipMiddle(text: string, head = KEEP_HEAD, tail = KEEP_TAIL): string {
  if (text.length <= head + tail) return text;
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} characters left out …]\n${text.slice(-tail)}`;
}

/** The size in bytes of a base64 image, recorded in its place. */
export function imageBytes(base64: string | undefined): number | undefined {
  return base64 ? Math.floor((base64.length * 3) / 4) : undefined;
}
