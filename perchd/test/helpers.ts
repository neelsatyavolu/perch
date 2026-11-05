import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway Chrome profile folder, removed by the returned cleanup. */
export function tempProfile(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "perchd-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

import { Browser } from "../src/browser/browser";
import { startFixtures } from "./fixtures/server";

/** One headless browser and fixture server per test file. */
export async function setup(): Promise<{ browser: Browser; site: ReturnType<typeof startFixtures>; teardown: () => Promise<void> }> {
  const profile = tempProfile();
  const site = startFixtures();
  const browser = await Browser.launch({ userDataDir: profile.dir });
  return {
    browser,
    site,
    teardown: async () => {
      await browser.close();
      site.stop();
      profile.cleanup();
    },
  };
}
