import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import type { PerchApi } from "../../src/api";
import { createFakeApi } from "../../src/api/fake";
import { ago, ChatRail } from "../../src/pages/newtab/ChatRail";
import { NewTab } from "../../src/pages/newtab/NewTab";
import { renderWithApi } from "./render";

afterEach(cleanup);

describe("New tab page", () => {
  test("while the chats load it shows no 'No chats yet', only the address box", async () => {
    const fake = createFakeApi({ stepMs: 0 });
    let release = () => {};
    const api: PerchApi = { ...fake, listChats: (n) => new Promise((done) => (release = () => done(fake.listChats(n)))) };
    const { findByRole, queryByText, findByText } = renderWithApi(<NewTab />, { api });
    await findByRole("searchbox", { name: "Search or ask" });
    await new Promise((r) => setTimeout(r, 10));
    expect(queryByText(/No chats yet/)).toBeNull();
    expect(document.querySelector(".ntp-sec")).toBeNull();
    release();
    expect(await findByText("Waiting for your approval")).toBeTruthy();
  });

  test("coming back to the tab refreshes once, though focus and visibilitychange both fire", async () => {
    const fake = createFakeApi({ stepMs: 0 });
    let loads = 0;
    const api: PerchApi = { ...fake, listChats: (n) => (loads++, fake.listChats(n)) };
    const { findByText } = renderWithApi(<NewTab />, { api });
    await findByText("Waiting for your approval");
    expect(loads).toBe(1);
    window.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise((r) => setTimeout(r, 10));
    expect(loads).toBe(2);
  });

  test("shows the mark, the address box with Search | Ask, and the hints", async () => {
    const { findByRole, getByText, getByRole } = renderWithApi(<NewTab />);
    expect(await findByRole("searchbox", { name: "Search or ask" })).toBeTruthy();
    expect(getByRole("radio", { name: "Search" }).getAttribute("aria-checked")).toBe("true");
    expect(getByText("Google")).toBeTruthy();
    expect(getByText("Ask", { selector: ".hints span" })).toBeTruthy();
    expect(document.querySelector("h1")?.textContent).toBe("New tab");
  });

  test("Enter searches with Brave; Tab switches the query to Google; Backspace at the start switches back", async () => {
    const { findByRole, nav, queryByText } = renderWithApi(<NewTab />);
    const box = (await findByRole("searchbox", { name: "Search or ask" })) as HTMLInputElement;
    fireEvent.input(box, { target: { value: "perch browser" } });
    fireEvent.keyDown(box, { key: "Tab" });
    expect(queryByText("Google", { selector: ".engine-chip" })).toBeTruthy();
    box.setSelectionRange(0, 0);
    fireEvent.keyDown(box, { key: "Backspace" });
    expect(queryByText("Google", { selector: ".engine-chip" })).toBeNull();
    fireEvent.keyDown(box, { key: "Tab" });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(nav).toEqual([{ what: "query", detail: { text: "perch browser", mode: "search", engine: "google" } }]));
  });

  test("Tab in an empty box moves focus as usual", async () => {
    const { findByRole } = renderWithApi(<NewTab />);
    const box = await findByRole("searchbox", { name: "Search or ask" });
    const e = new KeyboardEvent("keydown", { key: "Tab", cancelable: true, bubbles: true });
    box.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  test("⌘Enter asks Perch", async () => {
    const { findByRole, nav } = renderWithApi(<NewTab />);
    const box = await findByRole("searchbox", { name: "Search or ask" });
    fireEvent.input(box, { target: { value: "summarise my unread mail" } });
    fireEvent.keyDown(box, { key: "Enter", metaKey: true });
    await waitFor(() => expect(nav[0]).toEqual({ what: "query", detail: { text: "summarise my unread mail", mode: "ask", engine: "brave" } }));
  });

  test("the model picker opens on providers, a provider lists its models, and search spans them all", async () => {
    const { findByRole, getByRole, queryByRole, nav, api } = renderWithApi(<NewTab />);
    fireEvent.click(await findByRole("button", { name: "Model for the task" }));
    const search = getByRole("combobox", { name: "Search models" });
    expect(document.activeElement).toBe(search);
    const options = () => [...document.querySelectorAll(".mm [role='option']")].map((o) => o.textContent);
    expect(options()).toEqual(["Codex", "Claude", "Claude Code", "Grok", "Settings"]);
    fireEvent.click(getByRole("option", { name: "Codex" }));
    expect(options()).toEqual(["Codex", "GPT-6 Astra", "GPT-6.1 Sol", "GPT-6 Luna"]);
    fireEvent.keyDown(search, { key: "Escape" });
    expect(options()[0]).toBe("Codex");
    fireEvent.input(search, { target: { value: "opus" } });
    expect(options()).toEqual(["Claude Opus 5.5Claude", "Claude Opus 5.5Claude Code"]);
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => expect(queryByRole("dialog", { name: "Choose a model" })).toBeNull());
    expect((await api.getComposer()).model).toBe("claude-code:claude-opus-5-5");
    fireEvent.click(getByRole("button", { name: "Model for the task" }));
    fireEvent.click(getByRole("option", { name: "Settings" }));
    await waitFor(() => expect(nav.at(-1)).toEqual({ what: "page", detail: { page: "settings", section: "models" } }));
  });

  test("the effort picker lists exactly the chosen model's efforts and keeps the nearest on a switch", async () => {
    const { findByRole, getByRole, api } = renderWithApi(<NewTab />);
    await api.setComposer({ model: "codex:gpt-6-astra", effort: "ultra" });
    fireEvent.click(await findByRole("button", { name: "Model for the task" }));
    const effort = (await findByRole("combobox", { name: "Effort" })) as HTMLSelectElement;
    expect([...effort.options].map((o) => o.text)).toEqual(["Low", "Medium", "High", "Extra high", "Max", "Ultra"]);
    fireEvent.click(getByRole("option", { name: "Claude" }));
    fireEvent.click(getByRole("option", { name: /Claude Opus 5\.5/ }));
    await waitFor(async () => expect((await api.getComposer()).effort).toBe("max"));
    await waitFor(() => expect([...(getByRole("combobox", { name: "Effort" }) as HTMLSelectElement).options].map((o) => o.text)).toEqual(["Low", "Medium", "High", "Extra high", "Max"]));
  });

  test("recent chats show three cards with state in words; Routines switches the panel", async () => {
    const { findByText, getByRole, getAllByRole, findByText: find } = renderWithApi(<NewTab />);
    expect(await findByText("Waiting for your approval")).toBeTruthy();
    const panel = getByRole("tabpanel", { name: "Chats" });
    expect(panel.querySelectorAll(".ccard").length).toBe(3);
    fireEvent.click(getByRole("tab", { name: "Routines" }));
    expect(await find("Morning mail summary")).toBeTruthy();
    expect(getByRole("tabpanel", { name: "Routines" })).toBeTruthy();
    expect(getAllByRole("tab").length).toBe(2);
  });

  test("suggested cards open their page; after memory setup a task card appears", async () => {
    const { findByRole, nav, api } = renderWithApi(<NewTab />);
    fireEvent.click(await findByRole("button", { name: /^Set up your memory/ }));
    await waitFor(() => expect(nav[0]).toEqual({ what: "page", detail: { page: "memory", section: undefined } }));
    await api.saveProfileDraft([]);
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await findByRole("button", { name: /^Summarise unread mail/ }));
    await waitFor(() => expect(nav[1]?.detail).toEqual({ text: "Summarise my unread mail, grouped by what needs a reply today", mode: "ask", engine: "brave" }));
  });

  test("one suggestion can be dismissed and the next one takes its place", async () => {
    const { findByRole, getByRole, queryByRole, api } = renderWithApi(<NewTab />);
    fireEvent.click(await findByRole("button", { name: "Dismiss Import from another browser" }));
    await waitFor(() => expect(queryByRole("button", { name: /^Import from another browser/ })).toBeNull());
    expect((await api.listSuggestions()).some((s) => s.id === "setup-import")).toBe(false);
    expect(getByRole("region", { name: "Suggested" })).toBeTruthy();
  });

  test("sections can be hidden and shown again", async () => {
    const { findByRole, getByRole, queryByRole } = renderWithApi(<NewTab />);
    fireEvent.click(await findByRole("button", { name: "Hide suggested" }));
    await waitFor(() => expect(queryByRole("region", { name: "Suggested" })).toBeNull());
    fireEvent.click(getByRole("button", { name: "Show suggested" }));
    await waitFor(() => expect(getByRole("region", { name: "Suggested" })).toBeTruthy());
  });

  test("the chat rail collapses, remembers it, and searches chats", async () => {
    const { findByRole, getByRole, api, queryByRole } = renderWithApi(<NewTab />);
    const toggle = await findByRole("button", { name: "Hide chats" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const search = getByRole("searchbox", { name: "Search chats" });
    fireEvent.input(search, { target: { value: "fares" } });
    await waitFor(() => expect(getByRole("button", { name: "Compare SFO to HND fares" })).toBeTruthy());
    await waitFor(() => expect(queryByRole("button", { name: "Summarise Priya's notes" })).toBeNull());
    expect(getByRole("button", { name: "Settings" })).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "Hide chats" }));
    await waitFor(async () => expect((await api.getNtpLayout()).railOpen).toBe(false));
    expect(getByRole("button", { name: "Show chats" }).getAttribute("aria-expanded")).toBe("false");
  });

  test("the chat rail lists pinned chats first and marks new and failed replies", () => {
    const at = "2026-11-05T09:00:00.000Z";
    const chats = [
      { id: "a", title: "Plain", snippet: "", updatedAt: "2026-11-05T10:00:00.000Z", status: "idle" as const },
      { id: "b", title: "Trip", snippet: "", updatedAt: at, status: "idle" as const, pinned: true as const },
      { id: "c", title: "Fresh", snippet: "Here it is", updatedAt: at, status: "idle" as const, unread: true as const },
      { id: "d", title: "Broke", snippet: "", updatedAt: at, status: "idle" as const, failed: true as const },
    ];
    const { getByRole } = renderWithApi(<ChatRail chats={chats} now={Date.parse("2026-11-05T12:00:00.000Z")} />);
    const rows = [...getByRole("list").querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
    expect(rows).toEqual(["Trip, Pinned", "Plain", "Fresh, New reply", "Broke, Failed"]);
    expect(ago("2026-11-05T09:00:00.000Z", Date.parse("2026-11-05T12:00:00.000Z"))).toBe("3 hours ago");
  });
});
