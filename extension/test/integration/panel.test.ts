import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tab } from "../../../perchd/src/browser/tab";
import { launch, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

async function sitePanel(tab: Tab): Promise<Tab> {
  const tabId = await h.tabIdOf(tab);
  const panel = await h.extensionPage(`popup.html?tabId=${tabId}`);
  await waitFor(() => panel.evaluate<boolean>("!!document.querySelector('[data-stat=blocked]')"), "the site view");
  return panel;
}

const clickByText = (panel: Tab, text: string) =>
  panel.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)}).click()`);

describe("site panel", () => {
  test("names the cookie banner it rejected on this page", async () => {
    const page = await h.open(h.site.url("site.localhost", "/onetrust.html"));
    await waitFor(() => page.evaluate<string | null>("window.consent"), "the banner choice");
    const tabId = await h.tabIdOf(page);
    // The content script reports after its click; give the report a moment to land.
    await waitFor(() => h.sw<boolean>(`chrome.storage.session.get("tab:${tabId}").then((v) => !!v["tab:${tabId}"]?.banner)`), "the banner record");
    const panel = await sitePanel(page);
    const banner = await waitFor(() => panel.evaluate<string | null>("document.querySelector('[data-stat=banner]')?.textContent ?? null"), "banner row");
    expect(banner).toBe("Rejected (OneTrust)");
    await panel.close();
    await page.close();
  });

  test("counts the tracking parameters removed from the page address", async () => {
    const page = await h.open(h.site.url("site.localhost", "/plain.html?utm_source=a&fbclid=b"));
    const panel = await sitePanel(page);
    expect(await panel.evaluate<string>("document.querySelector('[data-stat=params]').textContent")).toBe("1");
    await panel.close();
    await page.close();
  });

  test("the protections switch turns protections off for this site only", async () => {
    const page = await h.open(h.site.url("site.localhost", "/plain.html"));
    const panel = await sitePanel(page);
    await panel.evaluate(`document.querySelector('[role=switch]').click()`);
    const settings = await waitFor(async () => {
      const s = await h.sw<{ settings?: { sitesOff?: string[] } }>(`chrome.storage.local.get("settings")`);
      return s.settings?.sitesOff?.length ? s.settings : null;
    }, "the saved setting");
    expect(settings.sitesOff).toEqual(["site.localhost"]);
    expect(await panel.evaluate<boolean>("!document.querySelector('.note').classList.contains('hidden')")).toBe(true);
    await h.sw(`chrome.storage.local.set({ settings: {} })`);
    await panel.close();
    await page.close();
  });

  test("changing a permission applies to this site", async () => {
    const page = await h.open(h.site.url("site.localhost", "/plain.html"));
    const panel = await sitePanel(page);
    await panel.evaluate(`(() => { const s = document.querySelector('[data-permission=camera]'); s.value = "block"; s.dispatchEvent(new Event("change")); })()`);
    const url = JSON.stringify(h.site.url("site.localhost", "/plain.html"));
    const other = JSON.stringify(h.site.url("other.localhost", "/plain.html"));
    await waitFor(async () => ((await h.sw<string>(`chrome.contentSettings.camera.get({ primaryUrl: ${url} }).then((r) => r.setting)`)) === "block" ? true : null), "camera blocked");
    expect(await h.sw<string>(`chrome.contentSettings.camera.get({ primaryUrl: ${other} }).then((r) => r.setting)`)).toBe("ask");
    await h.sw(`chrome.contentSettings.camera.clear({})`);
    await panel.close();
    await page.close();
  });

  test("Forget this site clears its cookies after a confirmation", async () => {
    const page = await h.open(h.site.url("site.localhost", "/plain.html"));
    await page.evaluate(`document.cookie = "a=1; path=/"; document.cookie = "b=2; path=/"; localStorage.setItem("k", "v")`);
    const panel = await sitePanel(page);
    expect(await waitFor(() => panel.evaluate<string | null>(`[...document.querySelectorAll(".row span")].find((s) => s.textContent.endsWith("cookies"))?.textContent ?? null`), "cookie count")).toBe("2 cookies");
    await clickByText(panel, "Forget this site");
    expect(await panel.evaluate<string>("document.body.textContent")).toContain("Forget site.localhost?");
    await clickByText(panel, "Forget");
    const url = JSON.stringify(h.site.url("site.localhost", "/plain.html"));
    await waitFor(async () => ((await h.sw<number>(`chrome.cookies.getAll({ url: ${url} }).then((c) => c.length)`)) === 0 ? true : null), "cookies cleared");
    await waitFor(() => page.evaluate<boolean>(`localStorage.getItem("k") === null`), "storage cleared");
    await page.close();
  });
});
