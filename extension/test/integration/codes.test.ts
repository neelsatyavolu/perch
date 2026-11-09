import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Tab } from "../../../perchd/src/browser/tab";
import { base32Decode } from "../../src/totp/base32";
import { totp } from "../../src/totp/totp";
import { launch, waitFor, type Harness } from "./harness";

// The well-known example secret from authenticator docs, encoded in the fixture's QR code. Not a real account.
const SECRET = "JBSWY3DPEHPK3PXP";

let h: Harness;
beforeAll(async () => {
  h = await launch();
}, 60_000);
afterAll(async () => {
  await h?.close();
});

/** The panel as a page for a given tab, on its Codes view. */
async function codesPanel(tab: Tab): Promise<Tab> {
  const tabId = await h.tabIdOf(tab);
  const panel = await h.extensionPage(`popup.html?tabId=${tabId}&view=codes`);
  await waitFor(() => panel.evaluate<boolean>("!!document.querySelector('[data-codes]')"), "the codes view");
  return panel;
}

const statusText = (panel: Tab) => panel.evaluate<string>("document.querySelector('[role=status]').textContent");
const clickByText = (panel: Tab, text: string) =>
  panel.evaluate(`[...document.querySelectorAll("button")].find((b) => b.textContent === ${JSON.stringify(text)}).click()`);

async function currentCodes(): Promise<string[]> {
  const now = Date.now() / 1000;
  const key = base32Decode(SECRET);
  return Promise.all([totp(key, { time: now - 30 }), totp(key, { time: now }), totp(key, { time: now + 30 })]);
}

describe("authenticator", () => {
  test("scans the setup QR code shown on the page and adds the account for that site", async () => {
    const page = await h.open(h.site.url("site.localhost", "/totp-setup.html"));
    const panel = await codesPanel(page);
    expect(await panel.evaluate<string>("document.querySelector('[data-codes]').textContent")).toContain("No codes yet");
    await clickByText(panel, "Scan QR code on this page");
    expect(await waitFor(async () => ((await statusText(panel)) || null), "scan result")).toBe("Added Field Notes.");
    const shown = await waitFor(() => panel.evaluate<string | null>("document.querySelector('.code')?.textContent?.replace(' ', '') || null"), "a code");
    expect(await currentCodes()).toContain(shown);
    await panel.close();
    await page.close();
  });

  test("stores accounts encrypted in local storage only: no secret, issuer or account name in the clear", async () => {
    const local = JSON.stringify(await h.sw("chrome.storage.local.get(null)"));
    expect(local).toContain('"totp"');
    for (const plain of [SECRET, "Field Notes", "ana@example.test", "site.localhost"]) expect(local).not.toContain(plain);
    expect(await h.sw<Record<string, unknown>>("chrome.storage.sync.get(null)")).toEqual({});
  });

  test("Fill types the current code into the site's one-time-code field", async () => {
    const page = await h.open(h.site.url("site.localhost", "/totp-setup.html"));
    const panel = await codesPanel(page);
    await waitFor(() => panel.evaluate<boolean>("!!document.querySelector('.code')"), "the code row");
    await clickByText(panel, "Fill");
    const filled = await waitFor(() => page.evaluate<string>("document.getElementById('otp').value"), "the filled code");
    expect(await currentCodes()).toContain(filled);
    await page.close();
  });

  test("on another site the code can be copied but not filled", async () => {
    const page = await h.open(h.site.url("other.localhost", "/totp-setup.html"));
    const panel = await codesPanel(page);
    await waitFor(() => panel.evaluate<boolean>("!!document.querySelector('.code')"), "the code row");
    const fill = await panel.evaluate<{ disabled: boolean; title: string }>(
      `(() => { const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Fill"); return { disabled: b.disabled, title: b.title }; })()`,
    );
    expect(fill).toEqual({ disabled: true, title: "Fills only on site.localhost" });
    await panel.close();
    await page.close();
  });

  test("a page without a QR code gets a plain explanation", async () => {
    const page = await h.open(h.site.url("site.localhost", "/plain.html"));
    const panel = await codesPanel(page);
    await clickByText(panel, "Scan QR code on this page");
    expect(await waitFor(async () => ((await statusText(panel)) || null), "scan result")).toBe(
      "No QR code is visible on this page. Scroll it into view and try again.",
    );
    await panel.close();
    await page.close();
  });
});
