import { expect, test } from "bun:test";
import { FAILING, Progress, REPEATED, SAME_ELEMENT } from "../src/agent/progress";
import { DECLINED } from "../src/agent/session";

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

test("time spent waiting for the user does not count against the time budget", async () => {
  let now = 0;
  const p = new Progress({ maxMs: 10 * 60_000 }, () => now);
  now = 2 * 60_000;
  const answer = await p.whilePaused(async () => { now += 30 * 60_000; return true; });
  expect(answer).toBe(true);
  expect(p.timeUp()).toBe(false);
  expect(p.used()).toBeCloseTo(0.2);
  // A wait that throws still restarts the clock.
  await expect(p.whilePaused(async () => { now += 60_000; throw new Error("closed"); })).rejects.toThrow("closed");
  now += 8 * 60_000;
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

test("three failed actions in a row get a note to change approach; a success resets the count", () => {
  const p = new Progress({});
  expect(p.after(call("click", { ref: "e1" }), "No element e1", true)).toEqual([]);
  expect(p.after(call("type", { ref: "e2", text: "7:00" }), "not editable", true)).toEqual([]);
  expect(p.after(call("select", { ref: "e3", value: "7" }), "no such option", true)).toEqual([FAILING]);
  expect(p.after(call("snapshot"), "Page: ...", false)).toEqual([]);
  expect(p.after(call("click", { ref: "e4" }), "covered", true)).toEqual([]);
  expect(p.after(call("click", { ref: "e5" }), "covered", true)).toEqual([]);
  expect(p.after(call("click", { ref: "e6" }), "ok", false)).toEqual([]);
});

test("working one element again and again gets a note, even when each try differs", () => {
  const p = new Progress({});
  const notes = [
    p.after(call("click", { ref: "e45" }), "opened picker"),
    p.after(call("type", { ref: "e45", text: "7:00 AM" }), "typed"),
    p.after(call("snapshot"), "Page: maps"),
    p.after(call("type", { ref: "e45", text: "07:00" }), "typed again"),
    p.after(call("click", { ref: "e45" }), "picker"),
  ];
  expect(notes.slice(0, 4).flat()).toEqual([]);
  expect(notes[4]).toEqual([SAME_ELEMENT]);
  // Filling a form touches each field once: no note.
  const q = new Progress({});
  for (let i = 0; i < 8; i++) expect(q.after(call("type", { ref: `e${i}`, text: "x" }), "typed")).toEqual([]);
});

test("one loop note at a time: the same failing call says it repeats, not three things", () => {
  const p = new Progress({});
  p.after(call("click", { ref: "e9" }), "covered by dialog", true);
  p.after(call("click", { ref: "e9" }), "covered by dialog", true);
  expect(p.after(call("click", { ref: "e9" }), "covered by dialog", true)).toEqual([REPEATED]);
});

test("actions the user declined are not failures: no note to get the same thing another way", () => {
  const p = new Progress({});
  for (let i = 0; i < 3; i++) expect(p.after(call("click", { ref: `e${i}` }), DECLINED, true)).toEqual([]);
  expect(p.after(call("batch", { actions: [] }), `1. click e7: ${DECLINED}`, true)).toEqual([]);
});
