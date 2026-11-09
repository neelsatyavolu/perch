import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import type { CommandBarResult, PerchApi } from "../../src/api";
import { createFakeApi } from "../../src/api/fake";
import { CommandBar } from "../../src/pages/command-bar/CommandBar";
import { COMMANDS, matchCommands } from "../../src/pages/command-bar/commands";
import { renderWithApi } from "./render";

afterEach(cleanup);

const PLACEHOLDER = "Search tabs, history, bookmarks and commands";
const selected = () => document.querySelector('[role=option][aria-selected="true"] .cb-title')?.textContent;
const groupLabels = () => [...document.querySelectorAll(".cb-group-label")].map((g) => g.textContent);

/** A fake backend whose queryCommandBar answers only when the test says so. */
function controlledApi() {
  const calls: { text: string; answer: (r: readonly CommandBarResult[]) => void }[] = [];
  const api: PerchApi = {
    ...createFakeApi({ stepMs: 0 }),
    queryCommandBar: (text) => new Promise((resolve) => calls.push({ text, answer: resolve })),
  };
  return { api, calls };
}

async function open() {
  const r = renderWithApi(<CommandBar />);
  const box = (await r.findByRole("combobox", { name: PLACEHOLDER })) as HTMLInputElement;
  await r.findByRole("option", { name: /Inbox \(12\)/ });
  return { ...r, box };
}

describe("Command bar", () => {
  test("opens focused with the open tabs and a few commands, asking the browser once", async () => {
    const { api, calls } = controlledApi();
    const r = renderWithApi(<CommandBar />, { api });
    const box = await r.findByRole("combobox", { name: PLACEHOLDER });
    expect(box.getAttribute("placeholder")).toBe(PLACEHOLDER);
    expect(document.activeElement).toBe(box);
    expect(calls.map((c) => c.text)).toEqual([""]);
    calls[0]!.answer(await createFakeApi().queryCommandBar(""));
    await r.findByRole("option", { name: /Inbox \(12\)/ });
    expect(groupLabels()).toEqual(["Tabs", "Commands"]);
    expect(r.getAllByRole("option").length).toBe(5 + 4);
    expect(r.getByRole("option", { name: /New incognito window/ }).textContent).toContain("⇧⌘N");
    expect(r.getByRole("option", { name: /Weekend playlist/ }).textContent).toContain("music.example.com");
    expect(document.querySelector("h1")?.textContent).toBe("Command bar");
  });

  test("Down and Up move across groups and wrap; Enter runs the selected tab", async () => {
    const { box, nav } = await open();
    expect(selected()).toBe("Inbox (12) - Example Mail");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(selected()).toBe("Close duplicate tabs");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(selected()).toBe("Inbox (12) - Example Mail");
    for (let i = 0; i < 5; i++) fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(selected()).toBe("New tab");
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(selected()).toBe("Morning headlines");
    expect(box.getAttribute("aria-activedescendant")).toBe(document.querySelector('[role=option][aria-selected="true"]')?.id ?? "");
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(nav).toEqual([{ what: "command-bar", detail: { kind: "tab", tabId: 105 } }]));
  });

  test("Enter runs a command by its id, and a history result by its URL", async () => {
    const { box, nav, findByRole } = await open();
    fireEvent.input(box, { target: { value: "markdown" } });
    await waitFor(() => expect(selected()).toBe("Copy URL as Markdown"));
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(nav[0]).toEqual({ what: "command-bar", detail: { kind: "command", id: "copy-url-markdown" } }));
    fireEvent.input(box, { target: { value: "ramen" } });
    await findByRole("option", { name: /Ramen near Hayes Valley/ });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(nav[1]).toEqual({ what: "command-bar", detail: { kind: "history", url: "https://maps.example.com/search/ramen" } }));
  });

  test("groups show in the order Tabs, Commands, Bookmarks, History", async () => {
    const { api, calls } = controlledApi();
    const r = renderWithApi(<CommandBar />, { api });
    const box = await r.findByRole("combobox", { name: PLACEHOLDER });
    fireEvent.input(box, { target: { value: "open" } });
    await waitFor(() => expect(calls.length).toBe(2));
    calls[1]!.answer([
      { kind: "history", title: "Open source licences", url: "https://example.com/licences" },
      { kind: "bookmark", title: "OpenStreetMap", url: "https://www.openstreetmap.org/" },
      { kind: "tab", tabId: 7, title: "Open questions", url: "https://docs.example.com/q" },
    ]);
    await r.findByRole("option", { name: /Open questions/ });
    expect(groupLabels()).toEqual(["Tabs", "Commands", "Bookmarks", "History"]);
    const titles = r.getAllByRole("option").map((o) => o.querySelector(".cb-title")?.textContent);
    expect(titles[0]).toBe("Open questions");
    expect(titles.at(-2)).toBe("OpenStreetMap");
    expect(titles.at(-1)).toBe("Open source licences");
    expect(r.getByRole("option", { name: /OpenStreetMap/ }).textContent).toContain("openstreetmap.org");
  });

  test("no match shows a quiet line and Enter does nothing", async () => {
    const { box, nav, findByText, queryAllByRole } = await open();
    fireEvent.input(box, { target: { value: "zzqx nothing here" } });
    expect(await findByText("No matches")).toBeTruthy();
    expect(queryAllByRole("option").length).toBe(0);
    fireEvent.keyDown(box, { key: "Enter" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    await new Promise((r) => setTimeout(r, 120));
    expect(nav).toEqual([]);
  });

  test("Escape closes the bubble", async () => {
    const { box, nav } = await open();
    fireEvent.keyDown(box, { key: "Escape" });
    await waitFor(() => expect(nav).toEqual([{ what: "close-command-bar", detail: null }]));
  });

  test("hover selects and click runs", async () => {
    const { box, nav, findByRole } = await open();
    fireEvent.input(box, { target: { value: "copy" } });
    await waitFor(() => expect(selected()).toBe("Copy URL"));
    const row = [...document.querySelectorAll("[role=option]")].find((o) => o.querySelector(".cb-title")?.textContent === "Copy URL")!;
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.mouseMove(row.nextElementSibling!);
    expect(row.getAttribute("aria-selected")).toBe("false");
    fireEvent.mouseMove(row);
    expect(row.getAttribute("aria-selected")).toBe("true");
    fireEvent.click(row);
    await waitFor(() => expect(nav).toEqual([{ what: "command-bar", detail: { kind: "command", id: "copy-url" } }]));
  });

  test("only the latest query's results show, whatever order the answers arrive in", async () => {
    const { api, calls } = controlledApi();
    const r = renderWithApi(<CommandBar />, { api });
    const box = await r.findByRole("combobox", { name: PLACEHOLDER });
    fireEvent.input(box, { target: { value: "pl" } });
    await waitFor(() => expect(calls.length).toBe(2));
    fireEvent.input(box, { target: { value: "plan" } });
    await waitFor(() => expect(calls.length).toBe(3));
    expect(calls.map((c) => c.text)).toEqual(["", "pl", "plan"]);
    calls[2]!.answer([{ kind: "tab", tabId: 103, title: "Quarterly plan - Example Docs", url: "https://docs.example.com/d/plan" }]);
    await r.findByRole("option", { name: /Quarterly plan/ });
    calls[1]!.answer([{ kind: "tab", tabId: 104, title: "Weekend playlist", url: "https://music.example.com/playlist/7" }]);
    calls[0]!.answer([{ kind: "tab", tabId: 101, title: "Inbox (12) - Example Mail", url: "https://mail.example.com/inbox" }]);
    await new Promise((res) => setTimeout(res, 20));
    expect(r.queryByRole("option", { name: /Weekend playlist/ })).toBeNull();
    expect(r.queryByRole("option", { name: /Inbox/ })).toBeNull();
    expect(r.getByRole("option", { name: /Quarterly plan/ })).toBeTruthy();
  });

  test("Enter before the typed text's results arrive runs the first of those results, not a stale one", async () => {
    const nav: { what: string; detail: unknown }[] = [];
    const calls: { text: string; answer: (r: readonly CommandBarResult[]) => void }[] = [];
    const api: PerchApi = {
      ...createFakeApi({ stepMs: 0, onNavigate: (what, detail) => nav.push({ what, detail }) }),
      queryCommandBar: (text) => new Promise((resolve) => calls.push({ text, answer: resolve })),
    };
    const r = renderWithApi(<CommandBar />, { api });
    const box = await r.findByRole("combobox", { name: PLACEHOLDER });
    calls[0]!.answer([{ kind: "tab", tabId: 101, title: "Inbox (12) - Example Mail", url: "https://mail.example.com/inbox" }]);
    await r.findByRole("option", { name: /Inbox/ });
    fireEvent.input(box, { target: { value: "github" } });
    fireEvent.keyDown(box, { key: "Enter" });
    // Asked at once, without waiting out the debounce.
    expect(calls.map((c) => c.text)).toEqual(["", "github"]);
    await new Promise((res) => setTimeout(res, 20));
    expect(nav).toEqual([]);
    calls[1]!.answer([{ kind: "history", title: "GitHub", url: "https://github.com/" }]);
    await waitFor(() => expect(nav).toEqual([{ what: "command-bar", detail: { kind: "history", url: "https://github.com/" } }]));
    await new Promise((res) => setTimeout(res, 120));
    expect(calls.length).toBe(2);
  });

  test("typing quickly sends one debounced query", async () => {
    const { api, calls } = controlledApi();
    const r = renderWithApi(<CommandBar />, { api });
    const box = await r.findByRole("combobox", { name: PLACEHOLDER });
    for (const v of ["b", "be", "bet"]) fireEvent.input(box, { target: { value: v } });
    await waitFor(() => expect(calls.length).toBe(2));
    await new Promise((res) => setTimeout(res, 120));
    expect(calls.map((c) => c.text)).toEqual(["", "bet"]);
  });
});

describe("Command bar commands", () => {
  test("ids are the ones the browser maps", () => {
    expect(COMMANDS.map((c) => c.id)).toEqual([
      "new-tab", "new-window", "new-incognito-window", "close-duplicate-tabs", "close-tabs-older-than-day", "sleep-tab", "hide-chrome",
      "copy-url", "copy-url-markdown", "open-settings", "open-history", "open-downloads", "open-bookmarks", "open-extensions",
    ]);
  });

  test("match title and keywords, case-insensitively, by substring or word prefix", () => {
    const ids = (q: string) => matchCommands(q).map((c) => c.id);
    expect(ids("COPY")).toEqual(["copy-url", "copy-url-markdown"]);
    expect(ids("incog")).toEqual(["new-incognito-window"]);
    expect(ids("private")).toEqual(["new-incognito-window"]);
    expect(ids("open down")).toEqual(["open-downloads"]);
    expect(ids("preferences")).toEqual(["open-settings"]);
    expect(ids("zzz")).toEqual([]);
  });
});

describe("Fake command bar backend", () => {
  test("empty text lists open tabs; text matches tabs, history and bookmarks, at most 8 of each", async () => {
    const api = createFakeApi();
    expect((await api.queryCommandBar("")).every((r) => r.kind === "tab")).toBe(true);
    const plan = await api.queryCommandBar("plan");
    expect(plan.map((r) => r.kind)).toEqual(["tab", "history"]);
    const all = await api.queryCommandBar("example");
    for (const kind of ["tab", "history", "bookmark"] as const) expect(all.filter((r) => r.kind === kind).length).toBeLessThanOrEqual(8);
    await expect(api.runCommandBarItem({ kind: "tab", tabId: 9999 })).rejects.toThrow("That tab is closed");
    await expect(api.runCommandBarItem({ kind: "command" })).rejects.toThrow("Unknown command");
  });
});
