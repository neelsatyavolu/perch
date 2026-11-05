import { expect, test } from "bun:test";
import { profileLine } from "../../src/pages/import/ImportSteps";

test("a browser's profile line never repeats the browser's own name", () => {
  expect(profileLine("Safari", [{ name: "Safari" }])).toBe("1 profile");
  expect(profileLine("Aside", [{ name: "Personal" }])).toBe("Personal");
  expect(profileLine("Chrome", [{ name: "Work" }, { name: "Home" }])).toBe("2 profiles");
});
