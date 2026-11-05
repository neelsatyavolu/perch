/** "This site": protections switch, what was blocked, tools, permissions, cookies. */

import { loadSettings, saveSettings, withSiteProtection, isSiteOff } from "../shared/settings";
import { pictureInPicture } from "../media/inject";
import { errorText, h, switchButton } from "./dom";
import { PERMISSIONS, cookieCount, forgetSite, matchedCounts, permission, setPermission, type PermissionValue } from "./site";

type TabState = { banner: { cmp: string; url: string } | null };
type Reply<T> = { ok: true; value: T } | { ok: false; error: string };

async function ask<T>(message: object): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
  if (!reply) throw new Error("Perch's background service did not answer.");
  if (!reply.ok) throw new Error(reply.error);
  return reply.value;
}

export async function renderSite(root: HTMLElement, tab: chrome.tabs.Tab | undefined, url: URL | null): Promise<void> {
  if (!tab?.id || !url) {
    root.append(h("div", { class: "section" }, [h("p", { class: "mute", text: "Site tools work on web pages. Open a website to see what Perch blocked there." })]));
    return;
  }
  const tabId = tab.id;
  const status = h("p", { class: "caption", attrs: { role: "status" } });
  root.append(
    await protectionSection(url.hostname, tabId),
    await blockedSection(tabId, url),
    toolsSection(tabId, status),
    await permissionsSection(url.href),
    await cookiesSection(url, tabId),
    h("div", { class: "section" }, [status]),
  );
}

async function protectionSection(host: string, tabId: number): Promise<HTMLElement> {
  const settings = await loadSettings();
  const on = !isSiteOff(settings, host);
  const reload = h("div", { class: "note hidden" }, [
    h("span", { class: "grow", text: "Reload the page to apply the change." }),
    h("button", { text: "Reload", on: { click: () => void chrome.tabs.reload(tabId).then(() => window.close()) } }),
  ]);
  const toggle = switchButton("Protections for this site", on, (next) => {
    void loadSettings()
      .then((current) => saveSettings(withSiteProtection(current, host, next)))
      .then(() => reload.classList.remove("hidden"));
  });
  return h("div", { class: "section" }, [
    h("div", { class: "row" }, [
      h("div", { class: "grow" }, [
        h("div", { text: "Protections", attrs: { style: "color: var(--ink); font-weight: 500" } }),
        h("div", { class: "caption", text: "Blocking, cookie banners and tracking parameters" }),
      ]),
      toggle,
    ]),
    reload,
  ]);
}

async function blockedSection(tabId: number, url: URL): Promise<HTMLElement> {
  const counts = await matchedCounts(tabId).catch(() => null);
  const state = await ask<TabState>({ type: "tab-state", tabId }).catch(() => null);
  const banner = state?.banner && new URL(state.banner.url).hostname === url.hostname ? `Rejected (${state.banner.cmp})` : "None seen";
  const row = (label: string, value: string, id: string) =>
    h("div", { class: "row" }, [h("span", { class: "grow", text: label }), h("span", { class: "value", text: value, attrs: { "data-stat": id } })]);
  return h("div", { class: "section" }, [
    h("div", { class: "section-title", text: "On this page" }),
    row("Ads and trackers blocked", counts ? String(counts.blocked) : "–", "blocked"),
    row("Tracking parameters removed", counts ? String(counts.params) : "–", "params"),
    row("Cookie banner", banner, "banner"),
  ]);
}

function toolsSection(tabId: number, status: HTMLElement): HTMLElement {
  const run = (label: string, work: () => Promise<unknown>, closeAfter: boolean) =>
    h("button", {
      text: label,
      on: {
        click: () => {
          status.textContent = "";
          work().then(
            () => closeAfter && window.close(),
            (error: unknown) => (status.textContent = errorText(error)),
          );
        },
      },
    });
  return h("div", { class: "section" }, [
    h("div", { class: "section-title", text: "Tools" }),
    h("div", { class: "tools" }, [
      run("Reader view", () => ask({ type: "reader", tabId }), true),
      run("Full-page screenshot", () => ask({ type: "screenshot", tabId }), false),
      // Called here, not through the service worker, so the click's user gesture reaches the page.
      run("Picture in picture", () => pictureInPicture(tabId), false),
    ]),
  ]);
}

async function permissionsSection(url: string): Promise<HTMLElement> {
  const rows = await Promise.all(
    PERMISSIONS.map(async (p) => {
      const current = await permission(p.id, url).catch(() => null);
      const options: PermissionValue[] = p.canAsk ? ["ask", "allow", "block"] : ["allow", "block"];
      const select = h(
        "select",
        { attrs: { "aria-label": p.label, "data-permission": p.id } },
        options.map((o) => {
          const option = h("option", { text: o === "ask" ? "Ask" : o === "allow" ? "Allow" : "Block", attrs: { value: o } });
          option.selected = o === current;
          return option;
        }),
      );
      select.addEventListener("change", () => void setPermission(p.id, url, select.value as PermissionValue));
      return h("div", { class: "row" }, [h("label", { class: "grow", text: p.label }), select]);
    }),
  );
  return h("div", { class: "section" }, [h("div", { class: "section-title", text: "Permissions" }), ...rows]);
}

async function cookiesSection(url: URL, tabId: number): Promise<HTMLElement> {
  const count = await cookieCount(url.href).catch(() => 0);
  const section = h("div", { class: "section" });
  const idle = () =>
    section.replaceChildren(
      h("div", { class: "section-title", text: "Cookies and site data" }),
      h("div", { class: "row" }, [
        h("span", { class: "grow", text: count === 1 ? "1 cookie" : `${count} cookies` }),
        h("button", { class: "danger", text: "Forget this site", on: { click: confirm } }),
      ]),
    );
  const confirm = () =>
    section.replaceChildren(
      h("p", { text: `Forget ${url.hostname}? This clears its cookies and stored data and signs you out of it.` }),
      h("div", { class: "row", attrs: { style: "justify-content: flex-end; margin-top: 8px" } }, [
        h("button", { class: "quiet", text: "Cancel", on: { click: idle } }),
        h("button", {
          class: "primary",
          text: "Forget",
          on: { click: () => void forgetSite(url.href).then(() => chrome.tabs.reload(tabId)).then(() => window.close()) },
        }),
      ]),
    );
  idle();
  return section;
}
