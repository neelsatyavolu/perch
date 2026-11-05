import { expect, test } from "bun:test";
import { Progress, REPEATED } from "../src/agent/progress";

const call = (name: string, args: Record<string, unknown> = {}) => ({ id: "c", name, args });

test("step budget: one wrap-up note at 70%, one answer-now note at 90%, nothing else", () => {
  const p = new Progress({ maxSteps: 10 });
  const notes = Array.from({ length: 10 }, (_, i) => p.after(call("click", { ref: `e${i}` }), `result ${i}`));
  expect(notes.slice(0, 6).flat()).toEqual([]);
  expect(notes[6]).toEqual(["Budget: 3 of 10 steps left. Start wrapping up: get only what is still missing, then answer."]);
  expect(notes[7]).toEqual([]);
  expect(notes[8]).toEqual(["Budget: 1 of 10 steps left. Answer now with what pages have shown, and say what is unverified."]);
  expect(notes[9]).toEqual([]);
});

test("time budget counts minutes and says when time is up", () => {
  let now = 0;
  const p = new Progress({ maxMs: 10 * 60_000 }, () => now);
  expect(p.after(call("snapshot"), "a")).toEqual([]);
  now = 7.5 * 60_000;
  expect(p.after(call("click", { ref: "e1" }), "b")).toEqual(["Budget: about 3 of 10 minutes left. Start wrapping up: get only what is still missing, then answer."]);
  expect(p.timeUp()).toBe(false);
  now = 10 * 60_000;
  expect(p.timeUp()).toBe(true);
});

test("the same call with the same result a third time gets a note; a changing result does not", () => {
  const p = new Progress({});
  expect(p.after(call("click", { ref: "e4" }), "covered by dialog")).toEqual([]);
  expect(p.after(call("click", { ref: "e4" }), "covered by dialog")).toEqual([]);
  expect(p.after(call("click", { ref: "e4" }), "covered by dialog")).toEqual([REPEATED]);
  const q = new Progress({});
  for (let i = 0; i < 5; i++) expect(q.after(call("scroll", { dy: 800 }), `scrolled to ${i * 800}`)).toEqual([]);
  const r = new Progress({});
  for (let i = 0; i < 5; i++) expect(r.after(call("screenshot"), "screenshot 1280×720")).toEqual([]);
});
