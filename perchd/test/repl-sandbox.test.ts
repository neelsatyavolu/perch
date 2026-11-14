import { afterAll, beforeAll, expect, test } from "bun:test";
import { repl } from "../src/page/repl";
import { setup } from "./helpers";

let env: Awaited<ReturnType<typeof setup>>;
beforeAll(async () => { env = await setup(); });
afterAll(async () => { await env.teardown(); });

test("a scratch tab that failed to open is tried again on the next call", async () => {
  const tab = await env.browser.newTab(env.site.url("/mail.html"));
  const conn = env.browser.conn;
  const send = conn.send.bind(conn);
  let failures = 2; // the hidden tab, then the window it falls back to
  conn.send = ((method: string, params?: object, sessionId?: string) => {
    if (method === "Target.createTarget" && failures-- > 0) return Promise.reject(new Error("Target.createTarget: no"));
    return send(method, params, sessionId);
  }) as typeof conn.send;
  try {
    await expect(repl(tab, "1 + 1")).rejects.toThrow(/no/);
    expect(await repl(tab, "1 + 1")).toEqual({ result: 2 });
  } finally {
    conn.send = send;
    await tab.close();
  }
});
