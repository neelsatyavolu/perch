import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tab } from "../../../perchd/src/browser/tab";
import { launch, piercedTags, piercedText, waitFor, type Harness } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

/** The same call the menu, the shortcut and the panel make. */
async function toggleReader(tab: Tab): Promise<void> {
  const tabId = await h.tabIdOf(tab);
  await h.sw(`chrome.scripting.executeScript({ target: { tabId: ${tabId} }, files: ["content/reader.js"] }).then(() => true)`);
}

const readerOpen = (tab: Tab) => tab.evaluate<boolean>("!!document.querySelector('perch-reader')");

describe("reader view", () => {
  test("shows the article in its own view, without the page's navigation, ads or footer", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/article.html"));
    await toggleReader(tab);
    await waitFor(() => readerOpen(tab), "reader view");
    const text = await waitFor(async () => {
      const t = await piercedText(tab);
      return t.includes("Paragraph 8") ? t : null;
    }, "article text");
    const reader = text.slice(text.indexOf("Close"));
    expect(reader).toContain("Where birds perch");
    expect(reader).toContain("Ana Ortiz");
    expect(reader).toContain("Paragraph 1 of the article");
    expect(reader).not.toContain("Sponsored");
    expect(reader).not.toContain("Copyright Field Notes");
    expect(await tab.evaluate("document.documentElement.style.overflow")).toBe("hidden");
    await tab.close();
  });

  test("keeps no scripts, frames or handlers from the article, and drops javascript: links", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/article.html"));
    await tab.evaluate("window.pwned = null");
    await toggleReader(tab);
    await waitFor(() => readerOpen(tab), "reader view");
    await Bun.sleep(300);
    const tags = await piercedTags(tab);
    const pageScripts = await tab.evaluate<number>("document.querySelectorAll('script').length");
    const pageFrames = await tab.evaluate<number>("document.querySelectorAll('iframe').length");
    expect(tags.filter((t) => t === "script").length).toBe(pageScripts);
    expect(tags.filter((t) => t === "iframe").length).toBe(pageFrames);
    const { root } = await tab.send<{ root: unknown }>("DOM.getDocument", { depth: -1, pierce: true });
    const dom = JSON.stringify(root);
    expect(dom.split("onerror").length - 1).toBe(1); // only the page's own image
    expect(dom.split("javascript:").length - 1).toBe(1); // only the page's own link
    expect(await tab.evaluate("window.pwned")).toBeNull();
    await tab.close();
  });

  test("running it again closes the view and gives the page its scrolling back", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/article.html"));
    await toggleReader(tab);
    await waitFor(() => readerOpen(tab), "reader view");
    await toggleReader(tab);
    await waitFor(async () => !(await readerOpen(tab)), "reader view to close");
    expect(await tab.evaluate("document.documentElement.style.overflow")).toBe("");
    await tab.close();
  });

  test("says so when a page has no article", async () => {
    const tab = await h.open(h.site.url("site.localhost", "/plain.html"));
    await toggleReader(tab);
    const text = await waitFor(async () => {
      const t = await piercedText(tab);
      return t.includes("Reader view could not find") ? t : null;
    }, "empty message");
    expect(text).toContain("Reader view could not find an article on this page.");
    await tab.close();
  });
});
