import { expect, test } from "bun:test";
import { CdpError } from "../src/cdp/connection";
import { PerchDomain } from "../src/browser/perch-domain";
import { fakeConn } from "./fake-perch";

test("a method the browser lacks returns null once and is not asked again", async () => {
  const conn = fakeConn();
  const perch = new PerchDomain(conn);
  expect(await perch.setTaskStatus({ chatId: "c", status: "running", targetIds: [] })).toBeNull();
  expect(await perch.setTaskStatus({ chatId: "c", status: "idle", targetIds: [] })).toBeNull();
  expect(conn.calls.length).toBe(1);
  expect(perch.has("setTaskStatus")).toBe(false);
});

test("answers pass through, and other errors still throw", async () => {
  const conn = fakeConn({ "Perch.getOpenTabs": { windows: [] }, "Perch.revealChat": new CdpError("Perch.revealChat", "no such chat", -32000) });
  const perch = new PerchDomain(conn);
  expect(await perch.getOpenTabs()).toEqual({ windows: [] });
  await expect(perch.revealChat({ chatId: "x", mode: "side" })).rejects.toThrow(/no such chat/);
});

test("askRequested ignores empty text and keeps only known fields", () => {
  const conn = fakeConn();
  const seen: unknown[] = [];
  new PerchDomain(conn).onAskRequested((a) => seen.push(a));
  conn.fire("Perch.askRequested", { text: "  " });
  conn.fire("Perch.askRequested", { text: "summarise this", tabId: "g-1", extra: 1 });
  expect(seen).toEqual([{ text: "summarise this", tabId: "g-1" }]);
});
