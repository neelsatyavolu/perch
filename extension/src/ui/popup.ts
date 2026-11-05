/**
 * The per-site panel. Opened from the toolbar it describes the active tab; opened as a page with
 * ?tabId=N it describes that tab (the Chromium build anchors it to the address bar instead).
 */

import { h } from "./dom";
import { renderCodes } from "./panel-codes";
import { renderSite } from "./panel-site";

type View = "site" | "codes";

async function targetTab(): Promise<chrome.tabs.Tab | undefined> {
  const param = new URLSearchParams(location.search).get("tabId");
  if (param !== null) {
    const id = Number(param);
    document.body.classList.add("page");
    return Number.isSafeInteger(id) && id >= 0 ? chrome.tabs.get(id).catch(() => undefined) : undefined;
  }
  return (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
}

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  const tab = await targetTab();
  const url = tab?.url && /^https?:/.test(tab.url) ? new URL(tab.url) : null;
  const body = h("div");
  const tabs: Record<View, HTMLButtonElement> = {
    site: h("button", { text: "This site", attrs: { role: "tab", id: "tab-site" } }),
    codes: h("button", { text: "Codes", attrs: { role: "tab", id: "tab-codes" } }),
  };
  const show = (view: View) => {
    for (const [name, button] of Object.entries(tabs)) button.setAttribute("aria-selected", String(name === view));
    body.replaceChildren();
    if (view === "site") void renderSite(body, tab, url);
    else void renderCodes(body, tab, url);
  };
  tabs.site.addEventListener("click", () => show("site"));
  tabs.codes.addEventListener("click", () => show("codes"));

  app.replaceChildren(
    h("header", { class: "head" }, [
      h("div", { class: "host", text: url?.hostname ?? "Perch" }),
      h("div", { class: "segmented", attrs: { role: "tablist", "aria-label": "Panel" } }, [tabs.site, tabs.codes]),
    ]),
    body,
  );
  show(new URLSearchParams(location.search).get("view") === "codes" ? "codes" : "site");
}

void main();
