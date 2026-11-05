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
