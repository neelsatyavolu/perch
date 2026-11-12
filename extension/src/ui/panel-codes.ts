/** "Codes": one-time codes with copy and fill, and QR import from the page. */

import { parseOtpauth } from "../totp/otpauth";
import { AUTHENTICATOR_OFF, browserVault } from "../totp/stores";
import { secondsLeft } from "../totp/totp";
import { codeFor, type VaultEntry } from "../totp/vault";
import { errorText, h } from "./dom";
import { fillCode, scanTabForSetupCode, siteMatches } from "./codes";

export async function renderCodes(root: HTMLElement, tab: chrome.tabs.Tab | undefined, url: URL | null): Promise<void> {
  const vault = (await browserVault())?.vault;
  if (!vault) {
    root.append(h("div", { class: "section" }, [h("p", { class: "empty", text: AUTHENTICATOR_OFF })]));
    return;
  }
  const list = h("div", { attrs: { "data-codes": "" } });
  const status = h("p", { class: "caption", attrs: { role: "status" } });
  const scan = h("button", { text: "Scan QR code on this page" });
  const manage = h("button", { class: "quiet", text: "Manage", on: { click: () => void chrome.tabs.create({ url: chrome.runtime.getURL("options.html#codes") }) } });
  root.append(h("div", { class: "section" }, [list]), h("div", { class: "section" }, [h("div", { class: "tools" }, [scan, manage]), status]));

  let timer: ReturnType<typeof setInterval> | undefined;
  const draw = async () => {
    clearInterval(timer);
    let entries: VaultEntry[];
    try {
      entries = await vault.list();
    } catch (error) {
      list.replaceChildren(h("p", { class: "error", text: errorText(error) }));
      return;
    }
    if (entries.length === 0) {
      list.replaceChildren(h("p", { class: "empty", text: "No codes yet. When a site shows a setup QR code, scan it here." }));
      return;
    }
    const rows = entries.map((entry) => codeRow(entry, tab, url, status));
    list.replaceChildren(...rows.map((r) => r.node));
    const tick = () => rows.forEach((r) => void r.update());
    tick();
    timer = setInterval(tick, 1_000);
  };

  scan.addEventListener("click", async () => {
    status.textContent = "";
    if (!tab?.id || !url) {
      status.textContent = "Open the page that shows the QR code, then scan.";
      return;
    }
    try {
      const uri = await scanTabForSetupCode(tab);
      const account = parseOtpauth(uri);
      await vault.add(account, url.hostname);
      status.textContent = `Added ${account.issuer || account.account}.`;
      await draw();
    } catch (error) {
      status.textContent = errorText(error);
    }
  });
  await draw();
}

function codeRow(entry: VaultEntry, tab: chrome.tabs.Tab | undefined, url: URL | null, status: HTMLElement) {
  const code = h("div", { class: "code", attrs: { "data-code": entry.id } });
  const time = h("div", { class: "code-time" });
  const copy = h("button", { text: "Copy" });
  const fill = h("button", { text: "Fill" });
  const canFill = !!tab?.id && !!url && siteMatches(entry.site, url.hostname);
  fill.disabled = !canFill;
  if (!canFill) fill.title = entry.site ? `Fills only on ${entry.site}` : "Fills only on the site it was added from";

  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(await codeFor(entry));
    status.textContent = "Copied. The code changes every " + entry.period + " seconds.";
  });
  fill.addEventListener("click", async () => {
    try {
      await fillCode(tab!.id!, entry);
      window.close();
    } catch (error) {
      status.textContent = errorText(error);
    }
  });

  const node = h("div", { class: "code-row" }, [
    h("div", { class: "grow" }, [h("div", { class: "code-name", text: entry.issuer || entry.account }), entry.issuer ? h("div", { class: "code-account", text: entry.account }) : null]),
    h("div", {}, [code, time]),
    h("div", { class: "code-actions" }, [copy, fill]),
  ]);
  const update = async () => {
    const now = Date.now() / 1000;
    const value = await codeFor(entry, now);
    code.textContent = value.length === 6 ? `${value.slice(0, 3)} ${value.slice(3)}` : value;
    time.textContent = `${secondsLeft(now, entry.period)}s`;
  };
  return { node, update };
}
