import { expect, test } from "bun:test";
import { formatTranscript } from "../src/cli/transcript-format";

test("a transcript reads as a timeline of the run", () => {
  const time = "2026-11-17T08:00:01.000Z";
  const text = formatTranscript("Verify listings", "chat-1", [
    { kind: "run", runId: "r1", task: "Verify the listings", model: "claude-opus-5-5", mode: "guard", time },
    { kind: "turn", ms: 1200, text: "Opening the page", calls: [{ id: "c1", name: "navigate", args: { url: "https://bu.edu" } }], usage: { input: 900, output: 40 }, time },
    { kind: "tool", id: "c1", name: "navigate", ms: 800, approved: null, error: false, content: "Page: BU", time },
    { kind: "approval", label: 'Click button "Submit"', approved: false, time },
    { kind: "end", outcome: "error", text: "not found", ms: 4000, time },
  ]);
  expect(text).toContain("08:00:01 RUN r1 · claude-opus-5-5 · guard");
  expect(text).toContain('→ navigate {"url":"https://bu.edu"}');
  expect(text).toContain("MODEL 1.2s · 900 in / 40 out");
  expect(text).toContain('APPROVAL not allowed: Click button "Submit"');
  expect(text).toContain("END error after 4.0s\n    not found");
});

test("a chat with no runs recorded says so", () => {
  expect(formatTranscript("Old chat", "chat-0", [])).toContain("nothing recorded yet");
});
