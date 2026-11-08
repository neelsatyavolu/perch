/** Settings → Authenticator: add a code by setup key, rename, set its site, remove. */

import { normalizeHost } from "../shared/settings";
import { checkSecret } from "../totp/otpauth";
import { AUTHENTICATOR_OFF, browserVault } from "../totp/stores";
import type { VaultEntry } from "../totp/vault";
import { errorText, h } from "./dom";

const INTRO = "Codes are encrypted under a key Perch derives from your profile's key in the macOS Keychain, and never synced. A code fills only on its own site.";
const DEV_INTRO = "Codes are encrypted and never synced. In this development install the key is kept in the browser profile, not the Keychain. A code fills only on its own site.";

export async function codesPanel(): Promise<HTMLElement> {
  const open = await browserVault();
  if (!open) {
    return h("section", { class: "panel", attrs: { id: "codes" } }, [h("h2", { text: "Authenticator" }), h("p", { class: "intro", text: AUTHENTICATOR_OFF })]);
  }
  const { vault, keyInProfile } = open;
  const list = h("div");
  const status = h("p", { class: "caption", attrs: { role: "status" } });

  const draw = async () => {
    try {
      const entries = await vault.list();
      list.replaceChildren(...(entries.length ? entries.map((e) => entryRow(e)) : [h("div", { class: "item" }, [h("span", { class: "mute", text: "No codes saved." })])]));
    } catch (error) {
      list.replaceChildren(h("div", { class: "item" }, [h("span", { class: "error", text: errorText(error) })]));
    }
  };

  const entryRow = (entry: VaultEntry): HTMLElement => {
    const row = h("div", { class: "item" });
    const view = () =>
      row.replaceChildren(
        h("div", { class: "grow" }, [
          h("div", { class: "label", text: entry.issuer || entry.account }),
          h("div", { class: "detail", text: [entry.issuer ? entry.account : "", entry.site ? `fills on ${entry.site}` : "copy only"].filter(Boolean).join(" · ") }),
        ]),
        h("button", { text: "Edit", on: { click: edit } }),
        h("button", { class: "danger", text: "Remove", on: { click: confirmRemove } }),
      );
    const edit = () => {
      const issuer = input("Issuer", entry.issuer);
      const account = input("Account", entry.account);
      const site = input("Site it fills on", entry.site ?? "");
      row.replaceChildren(
        h("div", { class: "grow form", attrs: { style: "border: 0; padding: 0" } }, [
          h("div", { class: "fields" }, [issuer, account]),
          site,
          h("div", { class: "actions" }, [
            h("button", {
              class: "primary",
              text: "Save",
              on: {
                click: () =>
                  void vault
                    .rename(entry.id, { issuer: issuer.value, account: account.value, site: site.value.trim() ? normalizeHost(site.value) : null })
                    .then(draw, (e: unknown) => (status.textContent = errorText(e))),
              },
            }),
            h("button", { class: "quiet", text: "Cancel", on: { click: view } }),
          ]),
        ]),
      );
    };
    const confirmRemove = () =>
      row.replaceChildren(
        h("span", { class: "grow", text: `Remove ${entry.issuer || entry.account}? Make sure you can still sign in to it another way.` }),
        h("button", { class: "quiet", text: "Cancel", on: { click: view } }),
        h("button", { class: "primary", text: "Remove", on: { click: () => void vault.remove(entry.id).then(draw) } }),
      );
    view();
    return row;
  };

  const issuer = input("Issuer, such as GitHub", "");
  const account = input("Account", "");
  const key = input("Setup key", "");
  key.setAttribute("autocomplete", "off");
  key.setAttribute("spellcheck", "false");
  const site = input("Site it fills on, such as github.com", "");
  const add = h("button", { class: "primary", text: "Add code" });
  add.addEventListener("click", async () => {
    status.textContent = "";
    try {
      const secret = checkSecret(key.value);
      const host = site.value.trim() ? normalizeHost(site.value) : null;
      if (site.value.trim() && !host) throw new Error("The site should be a host name, such as github.com.");
      await vault.add({ issuer: issuer.value.trim(), account: account.value.trim(), secret, algorithm: "SHA1", digits: 6, period: 30 }, host);
      for (const field of [issuer, account, key, site]) field.value = "";
      status.textContent = "Code added.";
      await draw();
    } catch (error) {
      status.textContent = errorText(error);
    }
  });

  await draw();
  return h("section", { class: "panel", attrs: { id: "codes" } }, [
    h("h2", { text: "Authenticator" }),
    h("p", { class: "intro", text: keyInProfile ? DEV_INTRO : INTRO }),
    list,
    h("div", { class: "form" }, [h("div", { class: "fields" }, [issuer, account]), key, site, h("div", { class: "actions" }, [add, status])]),
  ]);
}

function input(placeholder: string, value: string): HTMLInputElement {
  const field = h("input", { attrs: { type: "text", placeholder, "aria-label": placeholder } });
  field.value = value;
  return field;
}
