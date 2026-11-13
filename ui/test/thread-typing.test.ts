import { expect, test } from "bun:test";
import { shownAlready } from "../src/components/thread";

test("a finished reply types on from what the live run already showed", () => {
  const answer = "The post comes from a New York Times guest essay.";
  expect(shownAlready(answer, answer)).toBe(answer.length);
  expect(shownAlready(`Checking the page for the byline.\n\n${answer.slice(0, 20)}`, answer)).toBe(20);
  expect(shownAlready(`Checking.\n\n${answer}`, answer)).toBe(answer.length);
  expect(shownAlready("Something else entirely.", answer)).toBe(0);
});
