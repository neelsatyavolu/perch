import { expect, test } from "bun:test";
import type { CdpConnection } from "../../src/cdp/connection";
import { applyCookies } from "../../src/import/cookies-cdp";
import type { Cookie } from "../../src/import/types";

const cookie = (name: string): Cookie => ({ name, value: "v", domain: ".example.com", path: "/", secure: true, httpOnly: false });
const fast = { batch: 30, one: 30 };

function conn(answer: (cookies: { name: string }[]) => Promise<unknown>): CdpConnection {
  return { send: (_method: string, params: { cookies: { name: string }[] }) => answer(params.cookies) } as unknown as CdpConnection;
}

test("a batch the browser never answers is retried one cookie at a time", async () => {
  const never = new Promise<never>(() => undefined);
  const calls: number[] = [];
  const c = conn((cookies) => {
    calls.push(cookies.length);
    return cookies.length > 1 ? never : Promise.resolve({ success: true });
  });
  expect(await applyCookies(c, [cookie("a"), cookie("b"), cookie("c")], fast)).toEqual({ applied: 3, failed: 0 });
  expect(calls).toEqual([3, 1, 1, 1]);
});

test("when single cookies get no answer either, the rest of the batch is given up on", async () => {
  const never = new Promise<never>(() => undefined);
  let calls = 0;
  const c = conn(() => {
    calls++;
    return never;
  });
  const many = Array.from({ length: 10 }, (_, i) => cookie(`c${i}`));
  expect(await applyCookies(c, many, fast)).toEqual({ applied: 0, failed: 10 });
  expect(calls).toBe(4);
});
