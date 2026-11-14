import { expect, test } from "bun:test";
import { liveOrder, typeStep } from "../src/components/message";
import { shownAlready } from "../src/components/thread";

test("a finished reply types on from what the live run already showed", () => {
  const answer = "The post comes from a New York Times guest essay.";
  expect(shownAlready(answer, answer)).toBe(answer.length);
  expect(shownAlready(`Checking the page for the byline.\n\n${answer.slice(0, 20)}`, answer)).toBe(20);
  expect(shownAlready(`Checking.\n\n${answer}`, answer)).toBe(answer.length);
  expect(shownAlready("Something else entirely.", answer)).toBe(0);
});

test("what the agent says between steps lands before the step it led to; only text since the last step is the reply", () => {
  const text = "Title: Pens\nI'll open the shop.Now reading reviews.The best pen is the Kaweco.";
  const a = text.indexOf("I'll");
  const marks = [a + "I'll open the shop.".length, a + "I'll open the shop.Now reading reviews.".length];
  expect(liveOrder(text, 2, marks)).toEqual({ notes: ["I'll open the shop.", "Now reading reviews."], tail: "The best pen is the Kaweco." });
  // Steps with no mark (a snapshot from perchd) leave the text where it streams in, below them.
  expect(liveOrder("Looking.", 2)).toEqual({ notes: ["", ""], tail: "Looking." });
  // A half-streamed title line never shows.
  expect(liveOrder("Title: Pe", 0).tail).toBe("");
});

test("the reveal drains a share of the backlog by elapsed time, so it never falls far behind", () => {
  expect(typeStep(0, 16)).toBe(0);
  expect(typeStep(3, 16)).toBeLessThanOrEqual(3);
  expect(typeStep(5, 16)).toBeGreaterThanOrEqual(2);
  // A 5,000-character answer is on screen within about a second of 60fps frames.
  let behind = 5000;
  let frames = 0;
  while (behind > 0) {
    behind -= typeStep(behind, 1000 / 60);
    frames++;
  }
  expect(frames).toBeLessThan(70);
  // A long gap (slow frames, a page coming back) catches up at once.
  expect(typeStep(5000, 2000)).toBe(5000);
});
