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
  // The header stays put and only the body scrolls, so the popup keeps within Chrome's 600px cap
  // without a second scrollbar; the header's hairline shows once the body has moved under it.
  const body = h("div", { class: "scroll", attrs: { role: "tabpanel" } });
  const header = h("header", { class: "head" });
  const markScrolled = () => header.toggleAttribute("data-scrolled", body.scrollTop > 0);
  body.addEventListener("scroll", markScrolled, { passive: true });
  const tabs: Record<View, HTMLButtonElement> = {
    site: h("button", { text: "This site", attrs: { role: "tab", id: "tab-site" } }),
    codes: h("button", { text: "Codes", attrs: { role: "tab", id: "tab-codes" } }),
  };
  const show = (view: View) => {
    for (const [name, button] of Object.entries(tabs)) {
      button.setAttribute("aria-selected", String(name === view));
      // One tab stop for the tablist; the arrow keys move between tabs.
      button.tabIndex = name === view ? 0 : -1;
    }
    body.setAttribute("aria-labelledby", tabs[view].id);
    body.replaceChildren();
    body.scrollTop = 0;
    markScrolled();
    if (view === "site") void renderSite(body, tab, url);
    else void renderCodes(body, tab, url);
  };
  tabs.site.addEventListener("click", () => show("site"));
  tabs.codes.addEventListener("click", () => show("codes"));
  const tablist = h("div", { class: "segmented", attrs: { role: "tablist", "aria-label": "Panel" } }, [tabs.site, tabs.codes]);
  tablist.addEventListener("keydown", (event) => {
    const views: View[] = ["site", "codes"];
    const at = views.findIndex((v) => tabs[v] === document.activeElement);
    const next = event.key === "ArrowRight" ? at + 1 : event.key === "ArrowLeft" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? views.length - 1 : null;
    if (at < 0 || next === null) return;
    event.preventDefault();
    const view = views[(next + views.length) % views.length]!;
    if (tabs[view].getAttribute("aria-selected") !== "true") show(view);
    tabs[view].focus();
  });

  header.append(
    h("h1", { class: "host", text: url?.hostname ?? "Perch" }),
    tablist,
  );
  app.replaceChildren(header, body);
  show(new URLSearchParams(location.search).get("view") === "codes" ? "codes" : "site");
}

void main();
