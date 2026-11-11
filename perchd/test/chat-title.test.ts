import { expect, test } from "bun:test";
import { cleanTitle, provisionalTitle } from "../src/app/chat-title";

test("model titles are tidied: quotes, trailing punctuation and long runs", () => {
  expect(cleanTitle('"Compare SFO to HND fares."')).toBe("Compare SFO to HND fares");
  expect(cleanTitle("  Find   a pair of chinos  ")).toBe("Find a pair of chinos");
  expect(cleanTitle("")).toBeNull();
  expect(cleanTitle(42)).toBeNull();
  expect(cleanTitle("x".repeat(80))!.length).toBe(60);
});

test("a chat starts named after its first message, on one line", () => {
  expect(provisionalTitle("find me\na good pair")).toBe("find me a good pair");
  expect(provisionalTitle("y".repeat(70)).endsWith("…")).toBe(true);
});
