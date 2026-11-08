import { expect, test } from "bun:test";
import type { AppEvent } from "../src/app/protocol";
import { LiveThumbnails, type CastTab } from "../src/app/thumbnail";

/** A fake tab on a fake CDP connection: records commands and can push screencast frames. */
function fakeTab(id: string) {
  const sent: { method: string; params?: object }[] = [];
  const listeners = new Set<(p: unknown, sid?: string) => void>();
  const tab: CastTab & { sent: typeof sent; frame(data: string, n: number): void } = {
    id,
    session: `S-${id}`,
    closed: false,
    sent,
    conn: {
      on: (_event: string, l: (p: unknown, sid?: string) => void) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
    },
    async send<T>(method: string, params?: object) {
      sent.push({ method, params });
      return {} as T;
    },
    frame(data, n) {
      for (const l of listeners) l({ data, sessionId: n }, `S-${id}`);
    },
  };
  return tab;
}

const frames = (events: AppEvent[]) => events.filter((e): e is Extract<AppEvent, { type: "run.frame" }> => e.type === "run.frame");

test("a running chat's driven tab is cast, every frame acked, frames reach the pages, idle stops it", async () => {
  const events: AppEvent[] = [];
  const a = fakeTab("A");
  const thumbs = new LiveThumbnails({ emit: (e) => events.push(e), driving: () => a, minFrameMs: 0, pollMs: 60_000 });
  thumbs.update("c1", "running");
  await Bun.sleep(1);
  expect(a.sent[0]).toEqual({ method: "Page.startScreencast", params: { format: "jpeg", quality: 60, maxWidth: 240, maxHeight: 240, everyNthFrame: 1 } });
  a.frame("AAAA", 1);
  expect(a.sent).toContainEqual({ method: "Page.screencastFrameAck", params: { sessionId: 1 } });
  expect(frames(events)).toEqual([{ type: "run.frame", chatId: "c1", tabId: "A", data: "AAAA" }]);
  thumbs.update("c1", "idle");
  expect(a.sent.at(-1)?.method).toBe("Page.stopScreencast");
  expect(frames(events).at(-1)).toEqual({ type: "run.frame", chatId: "c1", tabId: null, data: null });
  a.frame("BBBB", 2);
  expect(frames(events).length).toBe(2);
});

test("the cast follows the agent to another tab", async () => {
  const events: AppEvent[] = [];
  const a = fakeTab("A");
  const b = fakeTab("B");
  let driving: CastTab = a;
  const thumbs = new LiveThumbnails({ emit: (e) => events.push(e), driving: () => driving, minFrameMs: 0, pollMs: 60_000 });
  thumbs.update("c1", "running");
  await Bun.sleep(1);
  driving = b;
  await thumbs.refresh();
  expect(a.sent.at(-1)?.method).toBe("Page.stopScreencast");
  expect(b.sent[0]?.method).toBe("Page.startScreencast");
  b.frame("BBBB", 1);
  expect(frames(events).at(-1)?.tabId).toBe("B");
  thumbs.stop();
});

test("frames are throttled", async () => {
  const events: AppEvent[] = [];
  const a = fakeTab("A");
  const thumbs = new LiveThumbnails({ emit: (e) => events.push(e), driving: () => a, minFrameMs: 10_000, pollMs: 60_000 });
  thumbs.update("c1", "running");
  await Bun.sleep(1);
  a.frame("1", 1);
  a.frame("2", 2);
  expect(frames(events).length).toBe(1);
  expect(a.sent.filter((s) => s.method === "Page.screencastFrameAck").length).toBe(2);
  thumbs.stop();
});
