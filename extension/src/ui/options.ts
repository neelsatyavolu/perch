/** Settings: feature switches, exempt sites, the authenticator, filter list details and shortcuts. */

import { FEATURES, loadSettings, saveSettings, withSiteProtection, type Settings } from "../shared/settings";
import { errorText, h, switchButton } from "./dom";
import { codesPanel } from "./options-codes";

function panel(title: string, intro: string | null, children: Node[], id?: string): HTMLElement {
  return h("section", { class: "panel", attrs: id ? { id } : {} }, [h("h2", { text: title }), intro ? h("p", { class: "intro", text: intro }) : null, ...children]);
}

function featuresPanel(settings: Settings): HTMLElement {
  const items = FEATURES.map((f) =>
    h("div", { class: "item" }, [
      h("div", { class: "grow" }, [h("div", { class: "label", text: f.label }), h("div", { class: "detail", text: f.detail })]),
      switchButton(f.label, settings[f.id], (on) => void loadSettings().then((s) => saveSettings({ ...s, [f.id]: on }))),
    ]),
  );
  return panel("Features", "Each works without sending anything to Perch or anyone else.", items);
}

function sitesPanel(settings: Settings): HTMLElement {
  const items = settings.sitesOff.map((host) => {
    const row = h("div", { class: "item" }, [h("div", { class: "grow mono", text: host })]);
    row.append(
      h("button", {
        text: "Turn protections back on",
        on: { click: () => void loadSettings().then((s) => saveSettings(withSiteProtection(s, host, true))).then(() => row.remove()) },
      }),
    );
    return row;
  });
  const empty = h("div", { class: "item" }, [h("span", { class: "mute", text: "None. Turn protections off for a site from its panel in the toolbar." })]);
  return panel("Sites with protections off", null, items.length ? items : [empty]);
}

async function listsPanel(): Promise<HTMLElement> {
  try {
    const meta = (await (await fetch(chrome.runtime.getURL("rules/meta.json"))).json()) as {
      built: string;
      lists: Record<string, { version: string | null }>;
      stats: Record<string, { rules: number }>;
    };
    const rulesetIds = await chrome.declarativeNetRequest.getEnabledRulesets();
    const rows = Object.entries(meta.lists).flatMap(([id, list]) => [
      h("dt", { text: id === "easylist" ? "EasyList" : id === "easyprivacy" ? "EasyPrivacy" : id }),
      h("dd", { text: `${list.version ?? "unknown version"} · ${meta.stats[id]?.rules ?? 0} rules · ${rulesetIds.includes(id) ? "on" : "off"}` }),
    ]);
    return panel(
      "Filter lists",
      "Lists are compiled into Perch and update with each Perch release. EasyList and EasyPrivacy are by the EasyList authors, under GPLv3 or CC BY-SA 3.0.",
      [h("dl", { class: "stats" }, rows)],
    );
  } catch (error) {
    return panel("Filter lists", null, [h("p", { class: "intro error", text: errorText(error) })]);
  }
}

async function shortcutsPanel(): Promise<HTMLElement> {
  const commands = await chrome.commands.getAll();
  const rows = commands
    .filter((c) => c.name && c.name !== "_execute_action")
    .flatMap((c) => [h("dt", { text: c.description ?? c.name ?? "" }), h("dd", { text: c.shortcut || "Not set" })]);
  return panel("Shortcuts", "Change them on the browser's extension shortcuts page.", [h("dl", { class: "stats" }, rows)]);
}

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  const settings = await loadSettings();
  app.replaceChildren(
    h("h1", { class: "page-title", text: "Perch settings" }),
    featuresPanel(settings),
    sitesPanel(settings),
    await codesPanel(),
    await listsPanel(),
    await shortcutsPanel(),
  );
  if (location.hash) document.querySelector(location.hash)?.scrollIntoView();
}

void main();
