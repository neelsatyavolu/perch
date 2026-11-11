import { expect, test } from "bun:test";
import { pageTextContext } from "../src/app/page-text";

test("page text goes in with the selection first, and says when it was cut", () => {
  const ctx = pageTextContext({ selection: "f'(x) = 2x", text: "Unit 3 practice\nQuestion 1", more: true });
  expect(ctx.indexOf("selected")).toBeLessThan(ctx.indexOf("Unit 3 practice"));
  expect(ctx).toContain("first 6000 characters");
  expect(ctx).toContain("snapshot before clicking");
  expect(pageTextContext({ selection: "", text: "", more: false })).toBe("");
});
