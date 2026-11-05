import { describe, expect, test } from "bun:test";
import {
  checkApiKey, checkCommand, checkEndpointUrl, checkMcpUrl, checkSecretName, checkSitePattern, checkSkillLocation, checkTime, checkTitle,
} from "../../src/lib/validate";

const ok = (r: { ok: boolean }) => r.ok;

describe("site patterns (Lulltab forms)", () => {
  test("accepts domains, exact hosts, subdomains, paths and URL prefixes", () => {
    for (const p of ["github.com", "=mail.google.com", "*.bank.com", "github.com/neel", "https://example.com/app", "localhost:3000"]) {
      expect(checkSitePattern(p)).toEqual({ ok: true, value: p });
    }
  });
  test("trims and lowercases the host", () => {
    expect(checkSitePattern("  GitHub.com ")).toEqual({ ok: true, value: "github.com" });
  });
  test("rejects empty, spaces and junk with a plain message", () => {
    const r = checkSitePattern("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe("Enter a site, like github.com");
    expect(ok(checkSitePattern("git hub.com"))).toBe(false);
    expect(ok(checkSitePattern("**"))).toBe(false);
    expect(ok(checkSitePattern("javascript:alert(1)"))).toBe(false);
  });
});

describe("URLs", () => {
  test("MCP servers need https, or http on this Mac", () => {
    expect(ok(checkMcpUrl("https://mcp.example.com/sse"))).toBe(true);
    expect(ok(checkMcpUrl("http://127.0.0.1:8080/mcp"))).toBe(true);
    expect(ok(checkMcpUrl("http://localhost:3000"))).toBe(true);
    expect(ok(checkMcpUrl("http://example.com/mcp"))).toBe(false);
    expect(ok(checkMcpUrl("file:///etc/passwd"))).toBe(false);
    expect(ok(checkMcpUrl("not a url"))).toBe(false);
  });
  test("model endpoints follow the same rule", () => {
    expect(ok(checkEndpointUrl("http://localhost:11434/v1"))).toBe(true);
    expect(ok(checkEndpointUrl("http://10.0.0.5/v1"))).toBe(false);
  });
});

describe("keys, commands and names", () => {
  test("API keys: no spaces, sensible length", () => {
    expect(ok(checkApiKey("sk-test-0000000000"))).toBe(true);
    expect(checkApiKey("  sk-test-0000000000 \n")).toEqual({ ok: true, value: "sk-test-0000000000" });
    expect(ok(checkApiKey("short"))).toBe(false);
    expect(ok(checkApiKey("has space inside"))).toBe(false);
  });
  test("stdio commands are one line", () => {
    expect(ok(checkCommand("npx -y @upstash/context7-mcp"))).toBe(true);
    expect(ok(checkCommand(""))).toBe(false);
    expect(ok(checkCommand("a\nb"))).toBe(false);
  });
  test("secret names look like env vars or headers", () => {
    expect(ok(checkSecretName("GITHUB_TOKEN"))).toBe(true);
    expect(ok(checkSecretName("Authorization"))).toBe(true);
    expect(ok(checkSecretName("1BAD"))).toBe(false);
    expect(ok(checkSecretName("has space"))).toBe(false);
  });
  test("titles are required and short", () => {
    expect(ok(checkTitle("Morning mail"))).toBe(true);
    expect(ok(checkTitle("   "))).toBe(false);
    expect(ok(checkTitle("x".repeat(121)))).toBe(false);
  });
});

describe("times and skill locations", () => {
  test("24-hour times", () => {
    expect(ok(checkTime("08:00"))).toBe(true);
    expect(ok(checkTime("23:59"))).toBe(true);
    expect(ok(checkTime("24:00"))).toBe(false);
    expect(ok(checkTime("8am"))).toBe(false);
  });
  test("skill folders, links and repos", () => {
    expect(ok(checkSkillLocation("folder", "~/skills/pdf"))).toBe(true);
    expect(ok(checkSkillLocation("folder", "relative/path"))).toBe(false);
    expect(ok(checkSkillLocation("url", "https://example.com/SKILL.md"))).toBe(true);
    expect(ok(checkSkillLocation("url", "http://example.com/SKILL.md"))).toBe(false);
    expect(ok(checkSkillLocation("git", "https://github.com/a/b.git"))).toBe(true);
    expect(ok(checkSkillLocation("git", "git@github.com:a/b.git"))).toBe(true);
    expect(ok(checkSkillLocation("git", "ftp://x"))).toBe(false);
  });
});
