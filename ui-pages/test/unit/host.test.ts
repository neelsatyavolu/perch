import { describe, expect, test } from "bun:test";
import { BROWSER_METHODS, createHostBridge, HostError, installHostBridge } from "../../src/api/host";
import { API_METHODS } from "../../src/api";

type Sent = { message: string; args: unknown[] };

function fakeWindow(opts: { config?: boolean; send?: boolean } = {}) {
  const sent: Sent[] = [];
  const win: Record<string, unknown> = {
    setTimeout: () => 0,
    ...(opts.config === false ? {} : { perchApp: { api: "http://127.0.0.1:4321", token: "t".repeat(43) } }),
    ...(opts.send === false ? {} : { chrome: { send: (message: string, args: unknown[]) => sent.push({ message, args }) } }),
  };
  return { win: win as unknown as Window, sent, cr: () => win.cr as { webUIResponse: (...a: unknown[]) => void; webUIListenerCallback: (...a: unknown[]) => void } };
}

describe("host bridge", () => {
  test("is absent outside Perch (no chrome.send)", () => {
    expect(createHostBridge(fakeWindow({ send: false }).win as never)).toBeNull();
  });

  test("browser methods go through chrome.send and resolve through cr.webUIResponse", async () => {
    const { win, sent, cr } = fakeWindow();
    const bridge = createHostBridge(win as never)!;
    const p = bridge.call("getPrivacy", []);
    expect(sent).toEqual([{ message: "perch.call", args: ["perch-1", "getPrivacy", []] }]);
    cr().webUIResponse("perch-1", true, { httpsOnly: true });
    expect(await p).toEqual({ httpsOnly: true });
  });

  test("a browser refusal rejects with its code and message", async () => {
    const { win, cr } = fakeWindow();
    const bridge = createHostBridge(win as never)!;
    const p = bridge.call("setAppearance", [{ theme: "x" }]);
    cr().webUIResponse("perch-1", false, { code: "invalid", message: "Unknown theme" });
    const error = (await p.catch((e) => e)) as HostError;
    expect(error).toBeInstanceOf(HostError);
    expect(error.message).toBe("Unknown theme");
    expect(error.code).toBe("invalid");
  });

  test("other methods go to perchd with the token and the args array", async () => {
    const { win } = fakeWindow();
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify([{ path: "USER.md" }]), { status: 200 });
    }) as unknown as typeof fetch;
    const bridge = createHostBridge(win as never, fetchFn)!;
    expect(await bridge.call("listMemoryPages", [])).toEqual([{ path: "USER.md" }]);
    expect(calls[0]!.url).toBe("http://127.0.0.1:4321/api/pages/listMemoryPages");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${"t".repeat(43)}`);
    expect(calls[0]!.init.body).toBe("[]");
  });

  test("perchd's errors become HostErrors, and an unreachable perchd says so", async () => {
    const { win } = fakeWindow();
    const refusing = (async () => new Response(JSON.stringify({ error: "That routine doesn't exist" }), { status: 400 })) as unknown as typeof fetch;
    const e1 = (await createHostBridge(win as never, refusing)!.call("runRoutine", ["r1"]).catch((e) => e)) as HostError;
    expect(e1.message).toBe("That routine doesn't exist");
    const down = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const e2 = (await createHostBridge(win as never, down, { waitMs: 0 })!.call("listRoutines", []).catch((e) => e)) as HostError;
    expect(e2.code).toBe("unavailable");
  });

  test("a page opened before perchd was up waits for it, reading config.js again until perchd answers", async () => {
    const { win } = fakeWindow({ config: false });
    const w = win as unknown as Record<string, unknown>;
    w.setTimeout = (fn: () => void) => (fn(), 0);
    let reloads = 0;
    const reload = async () => {
      reloads += 1;
      // perchd comes up on the second look.
      if (reloads === 2) w.perchApp = { api: "http://127.0.0.1:5555", token: "u".repeat(43) };
    };
    const urls: string[] = [];
    const fetchFn = (async (url: string) => (urls.push(url), new Response(JSON.stringify([]), { status: 200 }))) as unknown as typeof fetch;
    expect(await createHostBridge(win as never, fetchFn, { reload, waitMs: 5000 })!.call("listRoutines", [])).toEqual([]);
    expect(reloads).toBe(2);
    expect(urls).toEqual(["http://127.0.0.1:5555/api/pages/listRoutines"]);
  });

  test("appearance events from the browser reach subscribers", () => {
    const { win, cr } = fakeWindow();
    const bridge = createHostBridge(win as never)!;
    const seen: unknown[] = [];
    const stop = bridge.subscribe("appearance", (d) => seen.push(d));
    cr().webUIListenerCallback("perch-event", "appearance", { theme: "paper" });
    stop();
    cr().webUIListenerCallback("perch-event", "appearance", { theme: "ink" });
    expect(seen).toEqual([{ theme: "paper" }]);
  });

  test("installs window.perch once", () => {
    const { win } = fakeWindow();
    expect(installHostBridge(win as never)).toBe(true);
    const first = (win as unknown as { perch: unknown }).perch;
    installHostBridge(win as never);
    expect((win as unknown as { perch: unknown }).perch).toBe(first);
  });

  test("every browser method is a real API method", () => {
    for (const m of BROWSER_METHODS) expect(API_METHODS as readonly string[]).toContain(m);
  });
});
