import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import { NewTab } from "../../src/pages/newtab/NewTab";
import { renderWithApi } from "./render";

afterEach(cleanup);

describe("New tab page", () => {
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
    fireEvent.click(getByRole("button", { name: "Search chats" }));
    const search = getByRole("searchbox", { name: "Search chats" });
    fireEvent.input(search, { target: { value: "fares" } });
    await waitFor(() => expect(getByRole("button", { name: "Compare SFO to HND fares" })).toBeTruthy());
    await waitFor(() => expect(queryByRole("button", { name: "Summarise Priya's notes" })).toBeNull());
    fireEvent.click(getByRole("button", { name: "Hide chats" }));
    await waitFor(async () => expect((await api.getNtpLayout()).railOpen).toBe(false));
    expect(getByRole("button", { name: "Show chats" }).getAttribute("aria-expanded")).toBe("false");
  });
});
