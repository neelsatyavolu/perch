import { expect, test } from "bun:test";
import { changeNotes } from "../src/agent/changes";

const page = (lines: string[]) => lines.join("\n");
const results = ['- heading "Optometrists" [level=1]', '- text "354 results"', '- button "Virtual Visits" [ref=e9] pressed=false', ...Array.from({ length: 20 }, (_, i) => `- link "Dr. Person ${i}" [ref=e${20 + i}]`)];

test("an unchanged page is reported as unchanged, even when it redrew with new refs", () => {
  const redrawn = results.map((l) => l.replace(/ref=e(\d+)/, (_, n) => `ref=e${Number(n) + 100}`));
  expect(changeNotes({ before: page(results), after: page(redrawn), sameUrl: true }).unchanged).toBe(true);
});

test("a click that changes only its own button says the rest, results included, stayed the same", () => {
  const after = results.map((l) => l.replace("pressed=false", "pressed=true"));
  const notes = changeNotes({ before: page(results), after: page(after), sameUrl: true });
  expect(notes.unchanged).toBe(false);
  expect(notes.text).toContain("Only 1 line of the page changed");
  expect(notes.text).toContain('button "Virtual Visits" [ref=e9] pressed=true');
  expect(notes.text).toContain("did not update");
});

test("a real update of the results gets no small-change note", () => {
  const after = [...results.slice(0, 1), '- text "12 results"', ...Array.from({ length: 12 }, (_, i) => `- link "Dr. Other ${i}" [ref=e${60 + i}]`)];
  expect(changeNotes({ before: page(results), after: page(after), sameUrl: true }).text).toBe("");
});

test("new messages on the page are pointed out, such as validation errors and confirmations", () => {
  const after = [...results.slice(0, 3), '- alert', '  - text "Please select a size"', ...results.slice(3)];
  const notes = changeNotes({ before: page(results), after: page(after), sameUrl: true });
  expect(notes.text).toContain('New on the page: text "Please select a size"');
});

test("a new page gets no change notes", () => {
  const notes = changeNotes({ before: page(results), after: page(['- heading "Profile" [level=1]']), sameUrl: false });
  expect(notes.text).toBe("");
  expect(notes.unchanged).toBe(false);
});
