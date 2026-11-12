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
    // Each swap removes the focused button, so focus moves to the control that takes its place.
    const view = (focus?: "edit" | "remove") => {
      const editButton = h("button", { text: "Edit", on: { click: edit } });
      const removeButton = h("button", { class: "danger", text: "Remove", on: { click: confirmRemove } });
      row.replaceChildren(
        h("div", { class: "grow" }, [
          h("div", { class: "label", text: entry.issuer || entry.account }),
          h("div", { class: "detail", text: [entry.issuer ? entry.account : "", entry.site ? `fills on ${entry.site}` : "copy only"].filter(Boolean).join(" · ") }),
        ]),
        editButton,
        removeButton,
      );
      if (focus) (focus === "edit" ? editButton : removeButton).focus();
    };
    const edit = () => {
      const issuer = input("Issuer", entry.issuer);
      const account = input("Account", entry.account);
      const site = input("Site it fills on", entry.site ?? "");
      row.replaceChildren(
        h("div", { class: "grow form", attrs: { style: "border: 0; padding: 0" } }, [
          h("div", { class: "fields" }, [field("Issuer", issuer), field("Account", account)]),
          field("Site it fills on", site),
          h("div", { class: "actions" }, [
            h("button", { class: "quiet", text: "Cancel", on: { click: () => view("edit") } }),
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
          ]),
        ]),
      );
      issuer.focus();
    };
    const confirmRemove = () => {
      const cancel = h("button", { class: "quiet", text: "Cancel", on: { click: () => view("remove") } });
      row.replaceChildren(
        h("span", { class: "grow", text: `Remove ${entry.issuer || entry.account}? Make sure you can still sign in to it another way.` }),
        cancel,
        h("button", { class: "danger", text: "Remove", on: { click: () => void vault.remove(entry.id).then(draw) } }),
      );
      cancel.focus();
    };
    view();
    return row;
  };

  const issuer = input("Issuer", "", "GitHub");
  const account = input("Account", "", "you@example.com");
  const key = input("Setup key", "", "The key the site shows under its QR code");
  key.setAttribute("autocomplete", "off");
  key.setAttribute("spellcheck", "false");
  const site = input("Site it fills on", "", "github.com");
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
    h("div", { class: "form" }, [
      h("div", { class: "fields" }, [field("Issuer", issuer), field("Account", account)]),
      field("Setup key", key),
      field("Site it fills on", site),
      h("div", { class: "actions" }, [add, status]),
    ]),
  ]);
}

/** A visible label above a field, so a filled field still says what it holds. */
function field(label: string, control: HTMLInputElement): HTMLLabelElement {
  return h("label", { class: "field" }, [h("span", { class: "caption", text: label }), control]);
}

function input(label: string, value: string, placeholder = ""): HTMLInputElement {
  const field = h("input", { attrs: { type: "text", placeholder, "aria-label": label } });
  field.value = value;
  return field;
}
