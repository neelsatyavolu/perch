import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { MemoryPage } from "../../src/pages/memory/MemoryPage";
import { renderWithApi } from "./render";

afterEach(cleanup);
beforeEach(() => void (window.location.hash = ""));

describe("Memory page", () => {
  test("lists pages by folder and edits one", async () => {
    const r = renderWithApi(<MemoryPage />);
    expect(await r.findByRole("heading", { level: 1, name: "Memory" })).toBeTruthy();
    const list = r.getByRole("navigation", { name: "Memory pages" });
    expect(within(list).getByRole("heading", { name: "People" })).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Maya Chen" }));
    const body = (await r.findByRole("textbox", { name: "Maya Chen" })) as HTMLTextAreaElement;
    expect(body.value).toContain("prefers afternoons");
    fireEvent.input(body, { target: { value: "# Maya Chen\n\n- Prefers mornings now\n" } });
    fireEvent.click(r.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect((await r.api.readMemoryPage("people/maya-chen.md")).body).toContain("mornings"));
  });

  test("filters pages and deletes one after asking", async () => {
    const r = renderWithApi(<MemoryPage />);
    fireEvent.input(await r.findByRole("searchbox", { name: "Search memory" }), { target: { value: "jordan" } });
    const list = r.getByRole("navigation", { name: "Memory pages" });
    await waitFor(() => expect(within(list).getAllByRole("button").map((b) => b.textContent)).toEqual(["Jordan Patel"]));
    fireEvent.click(within(list).getByRole("button", { name: "Jordan Patel" }));
    fireEvent.click(await r.findByRole("button", { name: "Delete page" }));
    fireEvent.click(within(await r.findByRole("dialog", { name: "Delete Jordan Patel?" })).getByRole("button", { name: "Delete page" }));
    await waitFor(async () => expect((await r.api.listMemoryPages()).some((p) => p.title === "Jordan Patel")).toBe(false));
  });

  test("search finds pages by what they say, not only their titles", async () => {
    const r = renderWithApi(<MemoryPage />);
    fireEvent.input(await r.findByRole("searchbox", { name: "Search memory" }), { target: { value: "watch parties" } });
    const list = r.getByRole("navigation", { name: "Memory pages" });
    await waitFor(() => expect(within(list).getByRole("heading", { name: "Mentioned in" })).toBeTruthy());
    expect(within(list).getByRole("button", { name: /Jordan Patel/ }).textContent).toContain("watch parties on Saturdays");
  });

  test("history lists changes, and Undo takes one back", async () => {
    const r = renderWithApi(<MemoryPage />);
    fireEvent.click(await r.findByRole("button", { name: "History" }));
    const dialog = await r.findByRole("dialog", { name: "Memory history" });
    const before = (await r.api.listMemoryPages()).length;
    fireEvent.click((await within(dialog).findAllByRole("button", { name: "Undo" }))[0]!);
    await waitFor(async () => expect((await r.api.listMemoryPages()).length).toBe(before - 1));
  });

  test("Build my memory starts the research chat in a tab behind this one, even when memory came over from Aside", async () => {
    const r = renderWithApi(<MemoryPage />);
    const asked: (boolean | undefined)[] = [];
    const start = r.api.startMemoryChat.bind(r.api);
    r.api.startMemoryChat = async (always) => {
      asked.push(always);
      return start(always);
    };
    fireEvent.click(await r.findByRole("button", { name: "Build my memory" }));
    await waitFor(() => expect(asked).toEqual([true]));
    await waitFor(() => expect(r.nav.some((n) => n.what === "background-tab")).toBe(true));
  });

  test("pausing learning is one switch", async () => {
    const r = renderWithApi(<MemoryPage />);
    fireEvent.click(await r.findByRole("switch", { name: "Learn from chats" }));
    await waitFor(async () => expect((await r.api.getMemorySettings()).extraction).toBe(false));
  });
});

describe("Set up your memory", () => {
  test("sources have switches; web search is off; unavailable sources say why", async () => {
    window.location.hash = "#setup";
    const r = renderWithApi(<MemoryPage />);
    expect(await r.findByRole("heading", { level: 1, name: "Set up your memory" })).toBeTruthy();
    expect(r.getByRole("switch", { name: "Web search for your name" }).getAttribute("aria-checked")).toBe("false");
    expect(r.getByRole("switch", { name: "Messages" }).hasAttribute("disabled")).toBe(true);
    expect(r.getByText("Needs Full Disk Access")).toBeTruthy();
    expect(r.getByText("4 of 9 on")).toBeTruthy();
    fireEvent.click(r.getByRole("switch", { name: "Aside memory" }));
    expect(r.getByText("3 of 9 on")).toBeTruthy();
  });

  test("an export source asks for its file when switched on; cancelling leaves it off", async () => {
    window.location.hash = "#setup";
    let answer: string | null = null;
    const r = renderWithApi(<MemoryPage />, { pickFile: () => answer });
    fireEvent.click(await r.findByRole("switch", { name: "ChatGPT memory" }));
    await waitFor(() => expect(r.getByRole("switch", { name: "ChatGPT memory" }).getAttribute("aria-checked")).toBe("false"));
    answer = "chatgpt-2026-11.zip";
    fireEvent.click(r.getByRole("switch", { name: "ChatGPT memory" }));
    await waitFor(() => expect(r.getByRole("switch", { name: "ChatGPT memory" }).getAttribute("aria-checked")).toBe("true"));
    expect(r.getByText("From chatgpt-2026-11.zip")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Build my profile" }));
    const review = await r.findByRole("region", { name: "What Perch learned" });
    expect(await within(review).findByRole("button", { name: "Save to memory" })).toBeTruthy();
  });

  test("Messages offers Full Disk Access in System Settings", async () => {
    window.location.hash = "#setup";
    const r = renderWithApi(<MemoryPage />);
    fireEvent.click(await r.findByRole("button", { name: "Open System Settings to allow Messages" }));
    await waitFor(() => expect(r.nav.some((n) => n.what === "system-settings")).toBe(true));
  });

  test("coming back shows the finished draft, and follows a build that is still running", async () => {
    window.location.hash = "#setup";
    const first = renderWithApi(<MemoryPage />, { stepMs: 20 });
    fireEvent.click(await first.findByRole("button", { name: "Build my profile" }));
    await first.findByRole("progressbar", { name: "Building your profile" });
    const api = first.api;
    cleanup();

    const again = renderWithApi(<MemoryPage />, { api });
    expect(await again.findByRole("progressbar", { name: "Building your profile" })).toBeTruthy();
    const review = await again.findByRole("region", { name: "What Perch learned" });
    expect(await within(review).findByRole("button", { name: "Save to memory" }, { timeout: 3000 })).toBeTruthy();
    cleanup();

    const later = renderWithApi(<MemoryPage />, { api });
    const panel = await later.findByRole("region", { name: "What Perch learned" });
    expect(await within(panel).findByText("Draft · 8 facts")).toBeTruthy();
  });

  test("build, review (edit and remove), then save; nothing is saved before", async () => {
    window.location.hash = "#setup";
    const r = renderWithApi(<MemoryPage />);
    const before = await r.api.readMemoryPage("USER.md");
    fireEvent.click(await r.findByRole("button", { name: "Build my profile" }));
    const review = await r.findByRole("region", { name: "What Perch learned" });
    await within(review).findByRole("heading", { name: "Writing style" });
    expect((await r.api.readMemoryPage("USER.md")).body).toBe(before.body);
    fireEvent.click(within(review).getByRole("button", { name: "Remove “Goes by Neel”" }));
    fireEvent.click(within(review).getByRole("button", { name: "Edit “Flies Northwind; prefers aisle seats, nonstop”" }));
    const edit = within(review).getByRole("textbox", { name: "Edit fact" });
    fireEvent.input(edit, { target: { value: "Flies Northwind; window seats" } });
    fireEvent.keyDown(edit, { key: "Enter" });
    fireEvent.click(within(review).getByRole("button", { name: "Save to memory" }));
    expect(await r.findByText(/Saved 7 facts to memory/)).toBeTruthy();
    const saved = (await r.api.readMemoryPage("USER.md")).body;
    expect(saved).toContain("Flies Northwind; window seats");
    expect(saved.match(/Goes by Neel/g)?.length).toBe(1);
  });

  test("discard throws the draft away", async () => {
    window.location.hash = "#setup";
    const r = renderWithApi(<MemoryPage />);
    fireEvent.click(await r.findByRole("button", { name: "Build my profile" }));
    const review = await r.findByRole("region", { name: "What Perch learned" });
    await within(review).findByRole("button", { name: "Discard" });
    fireEvent.click(within(review).getByRole("button", { name: "Discard" }));
    expect(await r.findByText("Draft discarded. Nothing was saved.")).toBeTruthy();
    expect(await r.api.getProfileDraft()).toEqual([]);
  });
});
