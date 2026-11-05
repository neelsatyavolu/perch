/**
 * Loads the built extension into headless Chrome for Testing (perchd's launcher) and gives tests
 * a way to evaluate in its service worker, open pages and open the extension's own pages.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Browser } from "../../../perchd/src/browser/browser";
import type { Tab } from "../../../perchd/src/browser/tab";
import { build } from "../../scripts/build";
import { startFixtures } from "../fixtures/server";

const LISTS = join(import.meta.dir, "..", "fixtures", "lists");

let built: Promise<string> | null = null;

/** One build per test process, from the fixture filter lists. */
export function buildOnce(): Promise<string> {
  built ??= (async () => {
    const outDir = mkdtempSync(join(tmpdir(), "perch-ext-"));
    await build({ outDir, lists: { easylist: join(LISTS, "easylist.txt"), easyprivacy: join(LISTS, "easyprivacy.txt") } });
    process.once("exit", () => rmSync(outDir, { recursive: true, force: true }));
    return outDir;
  })();
  return built;
}

export type Harness = Awaited<ReturnType<typeof launch>>;

/** Launches with the fixture-list build, or with `extDir` when a test built its own. */
export async function launch(extraArgs: string[] = [], extDir?: string) {
  const ext = extDir ?? (await buildOnce());
  const profile = mkdtempSync(join(tmpdir(), "perch-ext-profile-"));
  const site = startFixtures();
  const browser = await Browser.launch({
    userDataDir: profile,
    // Extensions.loadUnpacked (rather than --load-extension) reports manifest errors to the test.
    // Each test tab has a window of its own; headless stacks them, and without the occlusion flag a
    // covered window stops painting part way through a screenshot.
    args: ["--enable-unsafe-extension-debugging", "--autoplay-policy=no-user-gesture-required", "--disable-backgrounding-occluded-windows", ...extraArgs],
  });
  const { id: extensionId } = await browser.conn.send<{ id: string }>("Extensions.loadUnpacked", { path: ext });

  const worker = await waitFor(async () => {
    const { targetInfos } = await browser.conn.send<{ targetInfos: { targetId: string; type: string; url: string }[] }>("Target.getTargets");
    return targetInfos.find((t) => t.type === "service_worker" && t.url === `chrome-extension://${extensionId}/background/index.js`) ?? null;
  }, "the extension's service worker");
  const { sessionId } = await browser.conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId: worker.targetId, flatten: true });

  /** Evaluates an expression in the service worker. `userGesture` stands in for a click or shortcut. */
  async function sw<T = unknown>(expression: string, userGesture = false): Promise<T> {
    const res = await browser.conn.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true, userGesture },
      sessionId,
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value as T;
  }

  // Settings are applied on install; wait until the content scripts are registered.
  await waitFor(async () => ((await sw<number>("chrome.scripting.getRegisteredContentScripts().then((s) => s.length)")) > 0 ? true : null), "content scripts");

  async function tabIdOf(tab: Tab): Promise<number> {
    const url = await tab.url();
    return waitFor(async () => sw<number | null>(`chrome.tabs.query({}).then((t) => t.find((x) => x.url === ${JSON.stringify(url)})?.id ?? null)`), `tab id for ${url}`);
  }

  return {
    browser,
    site,
    extensionId,
    sw,
    tabIdOf,
    open: (url: string) => browser.newTab(url),
    extensionPage: (path: string) => browser.newTab(`chrome-extension://${extensionId}/${path}`),
    async close() {
      await browser.close();
      site.stop();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

export async function waitFor<T>(probe: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await probe().catch(() => null);
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(50);
  }
}

/** Text of every node in the page, including closed shadow roots, through CDP's pierce option. */
export async function piercedText(tab: Tab): Promise<string> {
  const { root } = await tab.send<{ root: DomNode }>("DOM.getDocument", { depth: -1, pierce: true });
  const out: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType === 3 && node.nodeValue) out.push(node.nodeValue);
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  return out.join(" ").replace(/\s+/g, " ");
}

type DomNode = { nodeType: number; nodeName: string; nodeValue?: string; children?: DomNode[]; shadowRoots?: DomNode[]; attributes?: string[] };

/** Every element name in the page, including inside closed shadow roots. */
export async function piercedTags(tab: Tab): Promise<string[]> {
  const { root } = await tab.send<{ root: DomNode }>("DOM.getDocument", { depth: -1, pierce: true });
  const out: string[] = [];
  const walk = (node: DomNode) => {
    if (node.nodeType === 1) out.push(node.nodeName.toLowerCase());
    for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child);
  };
  walk(root);
  return out;
}
