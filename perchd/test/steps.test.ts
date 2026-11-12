import { expect, test } from "bun:test";
import { stepDetail } from "../src/agent/steps";
import { normalizeChat, normalizeSteps } from "../src/app/chats";
import type { Chat } from "../src/app/protocol";
import { stepLabel, toStep } from "../src/app/sidebar-runner";

test("a step's title from the model names it", () => {
  expect(stepLabel("script", { code: "await navigate('x')", title: "  Read each pen's reviews " })).toBe("Read each pen's reviews");
  expect(stepLabel("repl", { code: "1", title: "x".repeat(80) })).toHaveLength(60);
  expect(stepLabel("script", { code: "1", title: " " })).toBe("Script");
});

test("Claude Code's own tools read as plain words", () => {
  expect(stepLabel("WebSearch", { query: "best gel pens 2026" })).toBe('Search the web for "best gel pens 2026"');
  expect(stepLabel("WebFetch", { url: "https://www.jetpens.com/a", prompt: "x" })).toBe("Read www.jetpens.com");
  expect(stepLabel("TodoRead", {})).toBe("Todo read");
  expect(stepLabel("switch_tab", { id: "1" })).toBe("Switch tabs");
});

test("details show code, queries and URLs but never what is typed", () => {
  expect(stepDetail("script", { code: "  log(1)\n", title: "t" })).toBe("log(1)");
  expect(stepDetail("WebSearch", { query: "pens" })).toBe("pens");
  expect(stepDetail("navigate", { url: "https://a.com" })).toBe("https://a.com");
  expect(stepDetail("type", { ref: "e1", text: "hunter2" })).toBeUndefined();
  expect(stepDetail("fill_card", {})).toBeUndefined();
  expect(stepDetail("click", { ref: "e12" })).toBe('{"ref":"e12"}');
  expect(stepDetail("tabs", {})).toBeUndefined();
  const batch = stepDetail("batch", { actions: [{ name: "type", args: { ref: "e7", text: "secret" } }, { name: "click", args: { ref: "e9" } }] })!;
  expect(batch).toBe('type e7\nclick {"ref":"e9"}');
  expect(batch).not.toContain("secret");
});

test("tool results become the step's output, shortened", () => {
  const start = toStep({ type: "tool_execution_start", toolName: "repl", args: { code: "return 1", title: "Count pens" } });
  expect(start).toEqual({ type: "step", label: "Count pens", detail: "return 1" });
  const out = toStep({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "a".repeat(5000) }] } });
  expect(out?.type).toBe("step_output");
  expect(out?.type === "step_output" && out.output.length).toBeLessThan(4100);
  expect(toStep({ type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "  " }] } })).toBeNull();
});

test("steps saved as plain labels load as objects", () => {
  expect(normalizeSteps(["Open a.com", { label: "Click", detail: "e1" }, 5])).toEqual([{ label: "Open a.com" }, { label: "Click", detail: "e1" }]);
  const chat = { id: "c", messages: [{ id: "m", role: "assistant", text: "", time: "", steps: ["Open a.com"] }] } as unknown as Chat;
  expect(normalizeChat(chat).messages[0]!.steps).toEqual([{ label: "Open a.com" }]);
  const fresh = { id: "c", messages: [{ id: "m", role: "assistant", text: "", time: "", steps: [{ label: "x" }] }] } as unknown as Chat;
  expect(normalizeChat(fresh)).toBe(fresh);
});
