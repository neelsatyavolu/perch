import { describe, expect, test } from "bun:test";
import { API_METHODS, type JobProgress } from "../../src/api";
import { createRpcApi, isBridge } from "../../src/api/rpc";
import { appearanceFromQuery } from "../../src/api/resolve";

describe("RPC adapter", () => {
  test("every method becomes call(name, args)", async () => {
    const calls: [string, readonly unknown[]][] = [];
    const api = createRpcApi({
      call: async (method, args) => {
        calls.push([method, args]);
        return { ok: method };
      },
      subscribe: () => () => undefined,
    });
    expect(await api.setTaskModel("fast", { effort: "low" })).toEqual({ ok: "setTaskModel" } as never);
    await api.listChats(3);
    expect(calls).toEqual([["setTaskModel", ["fast", { effort: "low" }]], ["listChats", [3]]]);
    for (const m of API_METHODS) expect(typeof api[m]).toBe("function");
  });

  test("errors from perchd become Error objects with its message", async () => {
    const api = createRpcApi({ call: async () => Promise.reject("That server was removed"), subscribe: () => () => undefined });
    await expect(api.listMcpServers()).rejects.toThrow("That server was removed");
  });

  test("watchJob listens to job:<id> and drops malformed events", () => {
    const handlers = new Map<string, (d: unknown) => void>();
    const api = createRpcApi({ call: async () => null, subscribe: (event, l) => (handlers.set(event, l), () => handlers.delete(event)) });
    const seen: JobProgress[] = [];
    const stop = api.watchJob("j1", (p) => seen.push(p));
    const good: JobProgress = { jobId: "j1", state: "running", step: "Reading", done: 1, total: 3 };
    handlers.get("job:j1")!(good);
    handlers.get("job:j1")!({ jobId: "j1", state: "exploded" });
    expect(seen).toEqual([good]);
    stop();
    expect(handlers.has("job:j1")).toBe(false);
  });

  test("watchJob sees a job that finished before it subscribed (no replay from the bridge)", async () => {
    const finished: JobProgress = { jobId: "j2", state: "done", step: "Done", done: 3, total: 3, summary: ["412 bookmarks"] };
    const api = createRpcApi({
      call: async (method, args) => (method === "getJob" && args[0] === "j2" ? finished : null),
      subscribe: () => () => undefined,
    });
    const seen = await new Promise<JobProgress>((resolve) => api.watchJob("j2", resolve));
    expect(seen).toEqual(finished);
  });

  test("watchJob drops the snapshot when a live event got there first, and after unsubscribe", async () => {
    const handlers = new Map<string, (d: unknown) => void>();
    let answer: (v: unknown) => void = () => undefined;
    const api = createRpcApi({
      call: () => new Promise((resolve) => (answer = resolve)),
      subscribe: (event, l) => (handlers.set(event, l), () => handlers.delete(event)),
    });
    const seen: JobProgress[] = [];
    api.watchJob("j3", (p) => seen.push(p));
    const live: JobProgress = { jobId: "j3", state: "running", step: "Reading", done: 2, total: 3 };
    handlers.get("job:j3")!(live);
    answer({ jobId: "j3", state: "running", step: "Starting", done: 0, total: 3 });
    await Promise.resolve();
    await Promise.resolve();
    expect(seen).toEqual([live]);

    const after: JobProgress[] = [];
    const stop = api.watchJob("j4", (p) => after.push(p));
    stop();
    answer({ jobId: "j4", state: "done", step: "Done", done: 1, total: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(after).toEqual([]);
  });

  test("isBridge checks the injected object's shape", () => {
    expect(isBridge({ call: () => 0, subscribe: () => 0 })).toBe(true);
    expect(isBridge({ call: 1 })).toBe(false);
    expect(isBridge(undefined)).toBe(false);
  });
});

describe("fake-mode query parameters", () => {
  test("theme and accent from the URL, ignoring unknown values", () => {
    expect(appearanceFromQuery("?theme=paper&accent=rose")).toEqual({ theme: "paper", accent: "rose" });
    expect(appearanceFromQuery("?theme=purple")).toEqual({});
  });
});
