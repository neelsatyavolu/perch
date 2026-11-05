import { expect, test } from "bun:test";
import { isSecretField, REDACTED } from "../src/page/secrets";

test.each([
  [{ type: "password" }, true],
  [{ type: "PASSWORD" }, true],
  [{ autocomplete: "cc-number" }, true],
  [{ autocomplete: "cc-csc" }, true],
  [{ autocomplete: "CC-EXP" }, true],
  [{ autocomplete: "one-time-code" }, true],
  [{ autocomplete: "current-password" }, true],
  [{ autocomplete: "new-password" }, true],
  [{ autocomplete: "section-login current-password" }, true],
  [{ type: "text" }, false],
  [{ type: "email", autocomplete: "email" }, false],
  [{ type: "search" }, false],
  [{}, false],
])("isSecretField(%o) is %p", (attrs, expected) => {
  expect(isSecretField(attrs as Record<string, string>)).toBe(expected);
});

test("REDACTED hides length", () => {
  expect(REDACTED).toBe("••••");
});
