import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUE, POLICY_NAMES } from "../src/policy/catalogue";
import { cfPreferences, fakeSource } from "../src/policy/cfprefs";
import {
  agentAllowed, allowsClient, allowsModel, capMode, historyExtractionAllowed, importAllowed, isManaged, memoryAllowed,
  remoteControlAllowed, resolve, siteMatches, siteRuleFor, syncAllowed, syncBaseUrl, telemetryAllowed, type PolicyValue,
} from "../src/policy/policy";
import { PolicyWatcher } from "../src/policy/watch";
import { DEFAULT_API } from "../src/sync/api";

const forced = (name: string, value: unknown): PolicyValue => ({ name, value, forced: true });

test("only forced values count", () => {
  const { policy } = resolve([{ name: "AgentEnabled", value: false, forced: false }]);
  expect(policy.AgentEnabled).toBeUndefined();
  expect(resolve([forced("AgentEnabled", false)]).policy.AgentEnabled).toBe(false);
});

test("a forced value that fails its schema is dropped and reported", () => {
  const r = resolve([forced("MaxPermissionMode", "loud"), forced("UpdateDelayDays", 45), forced("AgentEnabled", "no")]);
  expect(r.policy).toEqual({});
  expect(r.errors.map((e) => e.name)).toEqual(["MaxPermissionMode", "UpdateDelayDays", "AgentEnabled"]);
  expect(r.errors[0]!.message).toContain("ask, guard, skip");
});

test("a list with one bad entry is dropped whole, never half-applied", () => {
  const r = resolve([forced("AgentSiteRules", [{ pattern: "bank.example", rule: "never" }, { pattern: "x.example", rule: "allow" }])]);
  expect(r.policy.AgentSiteRules).toBeUndefined();
  expect(r.errors[0]).toMatchObject({ name: "AgentSiteRules" });
});

test("dictionaries keep known keys and drop unknown ones", () => {
  const r = resolve([forced("ImportEnabled", { browsers: ["chrome"], extra: 1 })]);
  expect(r.policy.ImportEnabled).toEqual({ browsers: ["chrome"] });
});

test("TelemetryEnabled can only be forced off", () => {
  expect(resolve([forced("TelemetryEnabled", true)]).policy).toEqual({});
  expect(telemetryAllowed(resolve([forced("TelemetryEnabled", false)]).policy)).toBe(false);
});

test("unknown names are ignored", () => {
  expect(resolve([forced("HomepageLocation", "https://example.org")]).policy).toEqual({});
});

test("catalogue names match enterprise/policies.json", () => {
  const file = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "enterprise", "policies.json"), "utf8")) as { policies: { name: string; type: string }[] };
  expect(CATALOGUE.map((p) => p.name)).toEqual(file.policies.map((p) => p.name));
  expect(POLICY_NAMES).toContain("SyncDisabled");
  for (const p of CATALOGUE) if (p.default !== null) expect(resolve([forced(p.name, p.default)]).errors).toEqual([]);
});

test("capMode clamps skip to guard", () => {
  expect(capMode("skip", { MaxPermissionMode: "guard" })).toBe("guard");
  expect(capMode("ask", { MaxPermissionMode: "guard" })).toBe("ask");
  expect(capMode("skip", {})).toBe("skip");
});

test("a policy never-rule beats a user allow-rule", () => {
  const policy = { AgentSiteRules: [{ pattern: "bank.example", rule: "never" as const }, { pattern: "hr.example", rule: "ask" as const }] };
  expect(siteRuleFor("www.bank.example", "allow", policy)).toBe("never");
  expect(siteRuleFor("hr.example", "allow", policy)).toBe("ask");
  expect(siteRuleFor("hr.example", "never", policy)).toBe("never");
  expect(siteRuleFor("other.example", "allow", policy)).toBe("allow");
});

test("site patterns match the way Settings' site rules are written", () => {
  expect(siteMatches("bank.example", "bank.example")).toBe(true);
  expect(siteMatches("bank.example", "online.bank.example")).toBe(true);
  expect(siteMatches("bank.example", "notbank.example")).toBe(false);
  expect(siteMatches("=mail.example", "mail.example")).toBe(true);
  expect(siteMatches("=mail.example", "a.mail.example")).toBe(false);
  expect(siteMatches("*.example", "example")).toBe(false);
  expect(siteMatches("*.example", "a.example")).toBe(true);
  expect(siteMatches("https://bank.example/login", "bank.example")).toBe(true);
});

test("model, client and import rules", () => {
  const policy = { AllowedModelProviders: ["anthropic"], AllowedModels: ["anthropic/claude-sonnet-5-5"], AllowedMCPClients: ["codex"], ImportEnabled: { data: ["bookmarks"] } };
  expect(allowsModel("anthropic", "claude-sonnet-5-5", policy)).toBe(true);
  expect(allowsModel("anthropic", "claude-opus-5-5", policy)).toBe(false);
  expect(allowsModel("openai", "gpt-6-astra", policy)).toBe(false);
  expect(allowsClient("codex", policy)).toBe(true);
  expect(allowsClient("grok", policy)).toBe(false);
  expect(allowsClient("codex", { MCPServerEnabled: false })).toBe(false);
  expect(importAllowed("chrome", "bookmarks", policy)).toBe(true);
  expect(importAllowed("chrome", "passwords", policy)).toBe(false);
});

test("SyncServerURL must be https", () => {
  const r = resolve([forced("SyncServerURL", "http://sync.example.com")]);
  expect(r.errors[0]).toMatchObject({ name: "SyncServerURL" });
  expect(syncBaseUrl(r.policy)).toBe(DEFAULT_API);
  expect(syncBaseUrl(resolve([forced("SyncServerURL", "https://sync.example.com")]).policy)).toBe("https://sync.example.com");
});

test("Chrome's SyncDisabled turns Perch's sync off", () => {
  expect(syncAllowed(resolve([forced("SyncDisabled", true)]).policy)).toBe(false);
  expect(syncAllowed(resolve([forced("SyncEnabled", false)]).policy)).toBe(false);
});

test("an unmanaged Mac changes nothing", () => {
  const { policy, errors } = resolve(fakeSource([]).read(POLICY_NAMES));
  expect(errors).toEqual([]);
  expect(isManaged(policy)).toBe(false);
  expect(capMode("skip", policy)).toBe("skip");
  expect(siteRuleFor("bank.example", "allow", policy)).toBe("allow");
  expect(siteRuleFor("bank.example", undefined, policy)).toBeUndefined();
  for (const allowed of [agentAllowed, memoryAllowed, historyExtractionAllowed, remoteControlAllowed, syncAllowed, telemetryAllowed]) expect(allowed(policy)).toBe(true);
  expect(allowsModel("openai", "gpt-6-astra", policy) && allowsClient("grok", policy) && importAllowed("safari", "passwords", policy)).toBe(true);
  expect(syncBaseUrl(policy)).toBe(DEFAULT_API);
});

test("the watcher reads on first use and fires only when the policy changes", () => {
  let values: PolicyValue[] = [];
  const watcher = new PolicyWatcher({ source: fakeSource(() => values), watchDir: null });
  let fired = 0;
  watcher.onChange(() => fired++);
  expect(watcher.current()).toEqual({});
  values = [forced("MaxPermissionMode", "guard")];
  expect(watcher.refresh()).toBe(true);
  expect(watcher.current().MaxPermissionMode).toBe("guard");
  expect(watcher.refresh()).toBe(false);
  values = [forced("MaxPermissionMode", "nope")];
  watcher.refresh();
  expect(watcher.current()).toEqual({});
  expect(watcher.errors()[0]).toMatchObject({ name: "MaxPermissionMode" });
  expect(fired).toBe(2);
});

test("a source that throws keeps the last policy and reports the problem", () => {
  let fail = false;
  const watcher = new PolicyWatcher({ source: { read: () => { if (fail) throw new Error("boom"); return [forced("AgentEnabled", false)]; } }, watchDir: null });
  expect(watcher.current().AgentEnabled).toBe(false);
  fail = true;
  watcher.refresh();
  expect(watcher.current().AgentEnabled).toBe(false);
  expect(watcher.errors()[0]!.message).toContain("boom");
});

test.skipIf(process.platform !== "darwin")("the CoreFoundation reader returns a user-level value as not forced", () => {
  const domain = "com.perch.policytest";
  const write = (...args: string[]) => spawnSync("defaults", ["write", domain, ...args]);
  try {
    write("AgentEnabled", "-bool", "false");
    write("MaxPermissionMode", "-string", "guard");
    write("UpdateDelayDays", "-int", "7");
    write("AllowedModels", "-array", "anthropic/claude-sonnet-5-5", "openai/gpt-6-astra");
    write("ImportEnabled", "<dict><key>browsers</key><array><string>chrome</string></array></dict>");
    const values = cfPreferences(domain).read(["AgentEnabled", "MaxPermissionMode", "UpdateDelayDays", "AllowedModels", "ImportEnabled", "Missing"]);
    expect(values).toEqual([
      { name: "AgentEnabled", value: false, forced: false },
      { name: "MaxPermissionMode", value: "guard", forced: false },
      { name: "UpdateDelayDays", value: 7, forced: false },
      { name: "AllowedModels", value: ["anthropic/claude-sonnet-5-5", "openai/gpt-6-astra"], forced: false },
      { name: "ImportEnabled", value: { browsers: ["chrome"] }, forced: false },
    ]);
    expect(resolve(values).policy).toEqual({});
  } finally {
    spawnSync("defaults", ["delete", domain]);
  }
});
