import { expect, test } from "bun:test";
import type { CdpConnection } from "../../src/cdp/connection";
import { applyCookies } from "../../src/import/cookies-cdp";
import type { Cookie } from "../../src/import/types";

const cookie = (name: string, expires?: number): Cookie => ({ name, value: "v", domain: ".example.com", path: "/", secure: true, httpOnly: false, ...(expires !== undefined ? { expires } : {}) });
const never = new Promise<never>(() => undefined);

function conn(answer: (cookies: { name: string }[], call: number) => Promise<unknown>): { conn: CdpConnection; calls: number[] } {
  const calls: number[] = [];
  return { calls, conn: { send: (_method: string, params: { cookies: { name: string }[] }) => (calls.push(params.cookies.length), answer(params.cookies, calls.length)) } as unknown as CdpConnection };
}

test("a batch the browser never answers is tried again after the others", async () => {
  const c = conn((_cookies, call) => (call === 1 ? never : Promise.resolve({})));
  expect(await applyCookies(c.conn, [cookie("a"), cookie("b"), cookie("c")], 30)).toEqual({ applied: 3, failed: 0 });
  expect(c.calls).toEqual([3, 3]);
});

test("cookies that get no answer twice are left out, without holding up the import", async () => {
  const c = conn(() => never);
  const started = Date.now();
  expect(await applyCookies(c.conn, Array.from({ length: 10 }, (_, i) => cookie(`c${i}`)), 30)).toEqual({ applied: 0, failed: 10 });
  expect(c.calls).toEqual([10, 10]);
  expect(Date.now() - started).toBeLessThan(1000);
});

test("a refused batch goes one by one, keeping the good cookies", async () => {
  const c = conn((cookies) => (cookies.length > 1 ? Promise.reject(new Error("bad")) : cookies[0]!.name === "bad" ? Promise.resolve({ success: false }) : Promise.resolve({ success: true })));
  expect(await applyCookies(c.conn, [cookie("a"), cookie("bad"), cookie("c")], 30)).toEqual({ applied: 2, failed: 1 });
});

test("cookies that have already run out are not sent", async () => {
  const c = conn(() => Promise.resolve({}));
  expect(await applyCookies(c.conn, [cookie("old", 100), cookie("new", 4_000_000_000), cookie("session")], 30, 1_800_000_000_000)).toEqual({ applied: 2, failed: 0 });
  expect(c.calls).toEqual([2]);
});
