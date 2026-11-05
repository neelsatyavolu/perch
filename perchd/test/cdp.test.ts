import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encode, FrameDecoder } from "../src/cdp/pipe";
import { findChromeForTesting, launchChromium } from "../src/cdp/pipe";
import type { CdpConnection } from "../src/cdp/connection";
import { tempProfile } from "./helpers";

describe("framing", () => {
  test("encode ends with exactly one NUL", () => {
    const bytes = encode({ id: 1, method: "Browser.getVersion" });
    expect(bytes[bytes.length - 1]).toBe(0);
    expect(bytes.subarray(0, -1).includes(0)).toBe(false);
  });

  test("decoder splits two messages in one chunk", () => {
    const decoder = new FrameDecoder();
    const chunk = Buffer.concat([encode({ id: 1 }), encode({ id: 2 })]);
    expect(decoder.push(chunk)).toEqual([{ id: 1 }, { id: 2 }]);
  });

  test("decoder joins one message across three chunks", () => {
    const decoder = new FrameDecoder();
    const bytes = encode({ id: 7, result: { product: "x" } });
    expect(decoder.push(bytes.subarray(0, 5))).toEqual([]);
    expect(decoder.push(bytes.subarray(5, 12))).toEqual([]);
    expect(decoder.push(bytes.subarray(12))).toEqual([{ id: 7, result: { product: "x" } }]);
  });
});

describe("launch over the pipe", () => {
  let conn: CdpConnection;
  const profile = tempProfile();

  beforeAll(async () => {
    conn = await launchChromium({ executable: await findChromeForTesting(), userDataDir: profile.dir, headless: true });
  });
  afterAll(async () => {
    await conn.close();
    profile.cleanup();
  });

  test("Browser.getVersion answers", async () => {
    const version = await conn.send<{ product: string }>("Browser.getVersion");
    expect(version.product).toMatch(/^(Headless)?Chrome\/\d+/);
  });

  test("events reach listeners", async () => {
    await conn.send("Target.setDiscoverTargets", { discover: true });
    const created = new Promise<string>((resolve) => {
      const off = conn.on("Target.targetCreated", (params: { targetInfo: { url: string } }) => {
        if (params.targetInfo.url.startsWith("data:")) {
          off();
          resolve(params.targetInfo.url);
        }
      });
    });
    await conn.send("Target.createTarget", { url: "data:text/html,hi" });
    expect(await created).toBe("data:text/html,hi");
  });

  test("an unknown method rejects with the browser's error", async () => {
    await expect(conn.send("Nope.nothing")).rejects.toThrow(/wasn't found|not found/i);
  });
});

test("pending calls reject once the browser closes", async () => {
  const profile = tempProfile();
  const conn = await launchChromium({ executable: await findChromeForTesting(), userDataDir: profile.dir, headless: true });
  const { targetId } = await conn.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
  const pending = conn.send("Runtime.evaluate", { expression: "new Promise(() => {})", awaitPromise: true }, sessionId);
  await conn.close();
  await expect(pending).rejects.toThrow("browser closed");
  profile.cleanup();
});

test("a browser launched after another one closed keeps running", async () => {
  const { Browser } = await import("../src/browser/browser");
  const { scroll } = await import("../src/page/actions");
  const { snapshot } = await import("../src/page/snapshot");
  const { startFixtures } = await import("./fixtures/server");
  const first = tempProfile();
  const old = await launchChromium({ executable: await findChromeForTesting(), userDataDir: first.dir, headless: true });
  await old.close();
  first.cleanup();
  Bun.gc(true);

  const second = tempProfile();
  const site = startFixtures();
  const browser = await Browser.launch({ userDataDir: second.dir });
  const tab = await browser.newTab(site.url("/long.html"));
  for (let i = 0; i < 5; i++) {
    expect(await scroll(tab, { dy: 1500 })).toMatchObject({ ok: true });
    Bun.gc(true);
    expect((await snapshot(tab)).text).toContain("[ref=");
  }
  await browser.close();
  site.stop();
  second.cleanup();
}, 20_000);
