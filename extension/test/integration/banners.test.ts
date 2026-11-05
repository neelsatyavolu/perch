import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { launch, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

async function consentOn(path: string): Promise<{ consent: string; tabId: number }> {
  const tab = await h.open(h.site.url("site.localhost", path));
  const consent = await waitFor(() => tab.evaluate<string | null>("window.consent"), `a consent choice on ${path}`, 8_000);
  const tabId = await h.tabIdOf(tab);
  await tab.close();
  return { consent, tabId };
}

describe("cookie banners", () => {
  test("OneTrust: clicks Reject All on a banner that appears after load, and the panel says so", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/onetrust.html"));
    expect(await waitFor(() => tab.evaluate<string | null>("window.consent"), "OneTrust choice")).toBe("rejected");
    const tabId = await h.tabIdOf(tab);
    const state = await waitFor(async () => {
      const s = await h.sw<{ banner: { cmp: string } | null }>(`chrome.storage.session.get("tab:${tabId}").then((v) => v["tab:${tabId}"] ?? null)`);
      return s?.banner ? s : null;
    }, "banner record");
    expect(state.banner!.cmp).toBe("OneTrust");
    await tab.close();
  });

  test("OneTrust without a reject button: opens settings, unchecks everything optional, saves", async () => {
    expect((await consentOn("/onetrust-settings.html")).consent).toBe("saved:");
  });

  test("Usercentrics inside a closed shadow root: clicks Deny", async () => {
    expect((await consentOn("/usercentrics.html")).consent).toBe("denied");
  });

  test("Sourcepoint in a cross-origin iframe: clicks Reject", async () => {
    expect((await consentOn("/sourcepoint.html")).consent).toBe("rejected");
  });

  test("Quantcast with no first-layer reject: More options, Reject all, Save & exit", async () => {
    expect((await consentOn("/quantcast.html")).consent).toBe("saved:none");
  });

  test("never clicks a control that reads as accepting, even under a reject selector", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/accept-only.html"));
    await Bun.sleep(2_000);
    expect(await tab.evaluate("window.consent")).toBeNull();
    await tab.close();
  });

  describe("on a site with protections off", () => {
    beforeAll(async () => {
      await h.sw(`chrome.storage.local.set({ settings: { sitesOff: ["site.localhost"] } })`);
      await waitFor(async () => {
        const [script] = await h.sw<{ excludeMatches?: string[] }[]>(`chrome.scripting.getRegisteredContentScripts({ ids: ["perch-banners"] })`);
        return script?.excludeMatches?.length ? true : null;
      }, "banner script exclusion");
    });
    afterAll(async () => {
      await h.sw(`chrome.storage.local.set({ settings: {} })`);
    });

    test("does nothing to the page's own banner", async () => {
      const tab = await h.open(h.site.url("site.localhost", "/onetrust.html"));
      await Bun.sleep(2_000);
      expect(await tab.evaluate("window.consent")).toBeNull();
      await tab.close();
    });

    test("does nothing to a banner in a cross-origin consent frame either", async () => {
      const tab = await h.open(h.site.url("site.localhost", "/sourcepoint.html"));
      await Bun.sleep(2_000);
      expect(await tab.evaluate("window.consent")).toBeNull();
      await tab.close();
    });
  });
});
