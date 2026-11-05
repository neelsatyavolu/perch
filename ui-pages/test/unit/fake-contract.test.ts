import { describe, expect, test } from "bun:test";
import type { JobProgress, PerchApi } from "../../src/api";
import { type FakeOptions, createFakeApi } from "../../src/api/fake";

const api = (o: FakeOptions = {}): PerchApi => createFakeApi({ stepMs: 0, ...o });

const settle = (a: PerchApi, jobId: string) =>
  new Promise<JobProgress>((resolve) => {
    const stop = a.watchJob(jobId, (p) => {
      if (p.state !== "running") {
        stop();
        resolve(p);
      }
    });
  });

describe("fake backend: the contract the review asked for", () => {
  test("getJob and watchJob report a job that finished before anyone watched it", async () => {
    const a = api();
    const id = await a.startImport({ browser: "chrome", profile: "Default", kinds: ["bookmarks"] });
    await settle(a, id);
    expect((await a.getJob(id))?.state).toBe("done");
    expect(await a.getJob("nope")).toBeNull();
    const late = await new Promise<JobProgress>((resolve) => a.watchJob(id, resolve));
    expect(late.state).toBe("done");
  });

  test("a running profile build can be found again; the draft outlives the page", async () => {
    const a = api({ stepMs: 5 });
    const id = await a.startProfileBuild(["history"]);
    expect(await a.getProfileBuild()).toBe(id);
    await expect(a.startProfileBuild(["mail"])).rejects.toThrow("already running");
    await settle(a, id);
    expect(await a.getProfileBuild()).toBeNull();
    expect((await a.getProfileDraft()).length).toBeGreaterThan(0);
  });

  test("export-file sources need a file from chooseFile; unavailable sources are refused", async () => {
    const a = api();
    await expect(a.startProfileBuild(["chatgpt-memory"])).rejects.toThrow("Choose the export file for ChatGPT memory");
    await expect(a.startProfileBuild(["chatgpt-memory"], { "chatgpt-memory": "made-up" })).rejects.toThrow("Choose the export file");
    const f = await a.chooseFile("memory-export");
    expect(f?.name).toBe("export.zip");
    expect((await settle(a, await a.startProfileBuild(["chatgpt-memory"], { "chatgpt-memory": f!.id }))).state).toBe("done");
    await expect(a.startProfileBuild(["messages"])).rejects.toThrow("isn't available");
    expect(await api({ pickFile: () => null }).chooseFile("memory-export")).toBeNull();
  });

  test("Safari passwords need the exported CSV", async () => {
    const a = api();
    const req = { browser: "safari", profile: "default", kinds: ["passwords"] } as const;
    await expect(a.startImport(req)).rejects.toThrow("Choose the passwords file you exported");
    const csv = await a.chooseFile("passwords-csv");
    expect((await settle(a, await a.startImport({ ...req, passwordsCsv: csv!.id }))).state).toBe("done");
  });

  test("failing jobs say why", async () => {
    const a = api({ failJobs: "Chrome is open and has its files locked" });
    const p = await settle(a, await a.startImport({ browser: "chrome", profile: "Default", kinds: ["bookmarks"] }));
    expect(p).toMatchObject({ state: "failed", error: "Chrome is open and has its files locked" });
  });

  test("the company cap applies to new chats and every outside client", async () => {
    const a = api({ permissions: { maxMode: "guard" } });
    await expect(a.setPermissionMode("skip")).rejects.toThrow("organization");
    await expect(a.setClientMode("cli", "skip")).rejects.toThrow("organization");
    expect((await a.setClientMode("cli", "ask")).clientRules.find((c) => c.id === "cli")?.mode).toBe("ask");
  });

  test("addSiteRule replaces the rule for the same pattern in place", async () => {
    const a = api();
    const before = (await a.getPermissions()).siteRules;
    const after = (await a.addSiteRule({ pattern: "github.com", rule: "ask" })).siteRules;
    expect(after.length).toBe(before.length);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.find((r) => r.pattern === "github.com")?.rule).toBe("ask");
  });

  test("custom DNS needs an https resolver address in the same patch or already saved", async () => {
    const a = api();
    await expect(a.setPrivacy({ dohProvider: "custom" })).rejects.toThrow("https://");
    await expect(a.setPrivacy({ dohProvider: "custom", dohCustomUrl: "http://dns.example/dns-query" })).rejects.toThrow("https://");
    expect((await a.getPrivacy()).dohProvider).toBe("cloudflare");
    const p = await a.setPrivacy({ dohProvider: "custom", dohCustomUrl: "https://dns.example/dns-query" });
    expect(p).toMatchObject({ dohProvider: "custom", dohCustomUrl: "https://dns.example/dns-query" });
  });

  test("MCP tokens in command lines and URLs are redacted and named, on import and on add", async () => {
    const a = api();
    const linear = (await a.scanMcpImports()).find((c) => c.key === "codex:linear")!;
    expect(linear.target).toBe("https://mcp.linear.app/sse?api_key=${API_KEY}");
    expect(linear.secretNames).toEqual(["API_KEY"]);
    const [imported] = await a.importMcpServers(["codex:linear"]);
    expect(imported?.target).not.toContain("lin_api_");
    const added = await a.addMcpServer({ name: "notes", transport: "stdio", target: "notes-mcp --token tok-0000-secret", secrets: [] });
    expect(added.target).toBe("notes-mcp --token ${TOKEN}");
    expect(added.secretNames).toEqual(["TOKEN"]);
    expect(JSON.stringify(await a.listMcpServers())).not.toContain("tok-0000-secret");
  });

  test("trigger routines: a known event, and a site pattern for site-opened", async () => {
    const a = api();
    const r = await a.saveRoutine({ title: "Save PRs", prompt: "Note new review requests", schedule: { kind: "trigger", event: "site-opened", match: "GitHub.com/pulls" } });
    expect(r.schedule).toEqual({ kind: "trigger", event: "site-opened", match: "github.com/pulls" });
    await expect(a.saveRoutine({ title: "x", prompt: "y", schedule: { kind: "trigger", event: "site-opened" } })).rejects.toThrow("Enter a site");
    await expect(a.saveRoutine({ title: "x", prompt: "y", schedule: { kind: "trigger", event: "reboot" as never } })).rejects.toThrow("Pick what starts");
  });

  test("audit log is newest first and pages with before; dream logs are dated", async () => {
    const a = api();
    const all = await a.listAuditLog({ limit: 50 });
    expect(all.map((e) => e.at)).toEqual([...all.map((e) => e.at)].sort().reverse());
    const older = await a.listAuditLog({ limit: 2, before: all[1]!.at });
    expect(older.map((e) => e.id)).toEqual([all[2]!.id, all[3]!.id]);
    expect(await a.exportAuditLog()).toEqual({ name: "perch-audit-log.jsonl", entries: all.length });
    expect((await a.listDreamLogs(1))[0]?.lines.length).toBeGreaterThan(0);
  });
});
