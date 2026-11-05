import { describe, expect, test } from "bun:test";
import type { JobProgress, PerchApi } from "../../src/api";
import { createFakeApi } from "../../src/api/fake";

const api = (): PerchApi => createFakeApi({ stepMs: 0 });

function finish(a: PerchApi, jobId: string): Promise<JobProgress[]> {
  return new Promise((resolve) => {
    const seen: JobProgress[] = [];
    const stop = a.watchJob(jobId, (p) => {
      seen.push(p);
      if (p.state !== "running") {
        stop();
        resolve(seen);
      }
    });
  });
}

describe("fake backend", () => {
  test("appearance patches return a new object and reject unknown values", async () => {
    const a = api();
    const before = await a.getAppearance();
    const after = await a.setAppearance({ theme: "paper", accent: "teal" });
    expect(after).not.toBe(before);
    expect(before.theme).toBe("ink");
    expect(after.theme).toBe("paper");
    await expect(a.setAppearance({ theme: "purple" as never })).rejects.toThrow("Unknown theme");
  });

  test("setup suggestions disappear when done and tasks take their place", async () => {
    const a = api();
    expect((await a.listSuggestions()).map((s) => s.id)).toEqual(["setup-memory", "setup-routines", "setup-import"]);
    const job = await a.startProfileBuild(["history", "mail"]);
    await finish(a, job);
    await a.saveProfileDraft(await a.getProfileDraft());
    const after = await a.listSuggestions();
    expect(after.map((s) => s.id)).toEqual(["setup-routines", "setup-import", "task-mail"]);
    await a.dismissSuggestion("setup-import");
    expect((await a.listSuggestions()).some((s) => s.id === "setup-import")).toBe(false);
  });

  test("API keys never come back out", async () => {
    const a = api();
    const p = await a.connectProvider({ kind: "api-key", provider: "anthropic", key: "sk-ant-fake-123456789" });
    expect(p.state).toBe("connected");
    expect(p.account).toBe("Key ending 6789");
    expect(JSON.stringify(await a.listProviders())).not.toContain("sk-ant-fake");
    await expect(a.connectProvider({ kind: "api-key", provider: "openai", key: "bad key" })).rejects.toThrow();
  });

  test("MCP: import keeps only secret names; added servers hide values", async () => {
    const a = api();
    const found = await a.scanMcpImports();
    expect(found.find((c) => c.key === "claude-code:consult")?.alreadyAdded).toBe(true);
    const added = await a.importMcpServers(["claude-code:github", "cursor:postgres"]);
    expect(added.map((s) => s.name)).toEqual(["github", "postgres"]);
    expect((await a.scanMcpImports()).find((c) => c.key === "cursor:postgres")?.alreadyAdded).toBe(true);
    const server = await a.addMcpServer({ name: "notes", transport: "stdio", target: "notes-mcp", secrets: [{ name: "NOTES_TOKEN", value: "tok-secret-value" }] });
    expect(server.secretNames).toEqual(["NOTES_TOKEN"]);
    expect(JSON.stringify(await a.listMcpServers())).not.toContain("tok-secret-value");
    await expect(a.addMcpServer({ name: "web", transport: "http", target: "http://example.com", secrets: [] })).rejects.toThrow("https");
  });

  test("site rules validate their pattern", async () => {
    const a = api();
    const p = await a.addSiteRule({ pattern: "Bank.example.com", rule: "never" });
    expect(p.siteRules.at(-1)?.pattern).toBe("bank.example.com");
    await expect(a.addSiteRule({ pattern: "not a site", rule: "ask" })).rejects.toThrow();
    const removed = await a.removeSiteRule(p.siteRules[0]!.id);
    expect(removed.siteRules.length).toBe(p.siteRules.length - 1);
  });

  test("profile build reports progress; nothing is saved until Save", async () => {
    const a = api();
    const pagesBefore = await a.listMemoryPages();
    const seen = await finish(a, await a.startProfileBuild(["history"]));
    expect(seen.at(-1)?.state).toBe("done");
    expect(seen.some((p) => p.step === "Reading browsing history")).toBe(true);
    expect((await a.getProfileDraft()).length).toBeGreaterThan(0);
    expect(await a.listMemoryPages()).toEqual(pagesBefore);
    const { saved } = await a.saveProfileDraft((await a.getProfileDraft()).slice(0, 2));
    expect(saved).toBe(2);
    expect((await a.readMemoryPage("USER.md")).body).toContain("Builds Perch, agterm and Backrow");
  });

  test("routines: save, accept a proposal, delete", async () => {
    const a = api();
    const r = await a.saveRoutine({ title: "Daily standup notes", prompt: "Summarise yesterday", schedule: { kind: "daily", time: "09:00", days: ["mon"] } });
    expect((await a.listRoutines()).some((x) => x.id === r.id)).toBe(true);
    await expect(a.saveRoutine({ title: "Bad", prompt: "x", schedule: { kind: "daily", time: "25:00", days: ["mon"] } })).rejects.toThrow();
    const accepted = await a.acceptProposal("p1");
    expect(accepted.title).toBe("Friday expense report");
    expect((await a.findRoutineProposals()).some((p) => p.id === "p1")).toBe(false);
    await a.deleteRoutine(r.id);
    expect((await a.listRoutines()).some((x) => x.id === r.id)).toBe(false);
  });

  test("import finishes with a summary and clears the import suggestion", async () => {
    const a = api();
    const seen = await finish(a, await a.startImport({ browser: "chrome", profile: "Default", kinds: ["bookmarks", "tabs"] }));
    expect(seen.at(-1)?.summary).toEqual(["41 tabs, asleep until you open them", "1,290 bookmarks"]);
    expect((await a.listSuggestions()).some((s) => s.id === "setup-import")).toBe(false);
    await expect(a.startImport({ browser: "chrome", profile: "Default", kinds: [] })).rejects.toThrow("Pick at least one");
  });

  test("onboarding records steps and finishes", async () => {
    const a = api();
    expect((await a.completeOnboardingStep("appearance")).done).toEqual(["appearance"]);
    expect((await a.finishOnboarding()).finished).toBe(true);
  });
});
