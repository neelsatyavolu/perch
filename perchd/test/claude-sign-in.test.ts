import { expect, test } from "bun:test";
import { providers } from "@neelsatyavolu/shared-ai-auth";
import { claudeCode, isClaudeCallback } from "../src/app/pages/models";

const CALLBACK = providers.claude.redirectUri;

test("Claude's sign-in: Perch knows the page that carries the code, and reads code#state from its address", () => {
  const address = `${CALLBACK}?code=abc123&state=xyz789`;
  expect(isClaudeCallback(address)).toBe(true);
  expect(claudeCode(address)).toBe("abc123#xyz789");
  expect(isClaudeCallback(`${CALLBACK}?code=abc123`)).toBe(false);
  expect(isClaudeCallback("https://claude.com/cai/oauth/authorize?code=true")).toBe(false);
  expect(isClaudeCallback(`https://evil.example/?next=${CALLBACK}?code=a&state=b`)).toBe(false);
});
