import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { Settings } from "../../src/pages/settings/Settings";
import { SEARCH_INDEX } from "../../src/pages/settings/sections";
import { renderWithApi } from "./render";

beforeEach(() => {
  window.location.hash = "";
});
afterEach(cleanup);

const open = async (r: ReturnType<typeof renderWithApi>, name: string) => {
  fireEvent.click(await r.findByRole("link", { name }));
  return r.findByRole("heading", { level: 1, name });
};

describe("Settings shell", () => {
  test("opens on Appearance with every section in the nav", async () => {
    const r = renderWithApi(<Settings />);
    expect(await r.findByRole("heading", { level: 1, name: "Appearance" })).toBeTruthy();
    const nav = r.getByRole("navigation", { name: "Settings" });
    const names = within(nav).getAllByRole("link").map((a) => a.textContent);
    expect(names).toEqual(["Appearance", "Models", "Skills and MCP", "Permissions", "Privacy and security", "Memory", "Routines", "Import", "About and updates"]);
    expect(within(nav).getByRole("link", { name: "Appearance" }).getAttribute("aria-current")).toBe("page");
  });

  test("the hash picks the section", async () => {
    window.location.hash = "#privacy";
    const r = renderWithApi(<Settings />);
    expect(await r.findByRole("heading", { level: 1, name: "Privacy and security" })).toBeTruthy();
  });

  test("search finds rows across sections and jumps to them", async () => {
    const r = renderWithApi(<Settings />);
    const search = await r.findByRole("searchbox", { name: "Search settings" });
    fireEvent.input(search, { target: { value: "cookie" } });
    const results = await r.findByRole("list", { name: "Results" });
    const hits = within(results).getAllByRole("button").map((b) => b.textContent);
    expect(hits).toContain("Reject cookie bannersPrivacy and security");
    fireEvent.click(within(results).getByRole("button", { name: /Reject cookie banners/ }));
    expect(await r.findByRole("heading", { level: 1, name: "Privacy and security" })).toBeTruthy();
    await waitFor(() => expect(document.getElementById("cookie-banners")?.classList.contains("hit")).toBe(true));
  });

  test("search says so when nothing matches", async () => {
    const r = renderWithApi(<Settings />);
    fireEvent.input(await r.findByRole("searchbox", { name: "Search settings" }), { target: { value: "zzzz" } });
    expect(await r.findByText("No settings match “zzzz”")).toBeTruthy();
  });

  test("every search entry points at a row that exists", async () => {
    for (const entry of SEARCH_INDEX) {
      window.location.hash = `#${entry.section}`;
      const r = renderWithApi(<Settings />);
      await r.findByRole("heading", { level: 1 });
      await waitFor(() => expect(document.getElementById(entry.anchor)).toBeTruthy());
      cleanup();
    }
  });
});

describe("Appearance", () => {
  test("theme and accent pickers apply at once", async () => {
    const r = renderWithApi(<Settings />);
    await r.findByRole("heading", { level: 1, name: "Appearance" });
    fireEvent.click(r.getByRole("radio", { name: "Paper" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("paper"));
    fireEvent.keyDown(r.getByRole("radio", { name: "Blue" }), { key: "ArrowRight" });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#0B7C73"));
    expect((await r.api.getAppearance()).accent).toBe("teal");
  });

  test("Match system shows the dark theme choice; hide chrome has its hover option", async () => {
    const r = renderWithApi(<Settings />);
    await r.findByRole("heading", { level: 1, name: "Appearance" });
    expect(r.queryByRole("combobox", { name: "Dark theme" })).toBeNull();
    fireEvent.click(r.getByRole("switch", { name: "Match system" }));
    expect(await r.findByRole("combobox", { name: "Dark theme" })).toBeTruthy();
    expect(r.getByRole("switch", { name: "Show the bars at the top edge" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(r.getByRole("switch", { name: "Hide tab strip and bookmarks bar" }));
    await waitFor(() => expect(r.getByRole("switch", { name: "Show the bars at the top edge" }).hasAttribute("disabled")).toBe(false));
  });
});

describe("Models", () => {
  test("providers show sign-in state; signing in to Grok connects it", async () => {
    const r = renderWithApi(<Settings />);
    await open(r, "Models");
    expect(await r.findByText("Connected · neel@example.com")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Sign in to Grok" }));
    await waitFor(() => expect(r.getByRole("button", { name: "Sign out of Grok" })).toBeTruthy());
  });

  test("an API key is entered once and only a hint comes back", async () => {
    const r = renderWithApi(<Settings />);
    await open(r, "Models");
    fireEvent.click(await r.findByRole("button", { name: "Connect an API key or a model on this Mac" }));
    fireEvent.click(await r.findByRole("button", { name: "Add key for Anthropic API" }));
    const dlg = await r.findByRole("dialog", { name: "Add your Anthropic API key" });
    const field = within(dlg).getByLabelText("API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.input(field, { target: { value: "bad key" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save key" }));
    expect(await within(dlg).findByText("An API key can't contain spaces")).toBeTruthy();
    fireEvent.input(field, { target: { value: "sk-ant-fake-123456789" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save key" }));
    expect(await r.findByText("Connected · Key ending 6789")).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("sk-ant-fake");
  });

  test("every task model role has a picker; changes are saved", async () => {
    const r = renderWithApi(<Settings />);
    await open(r, "Models");
    for (const role of ["Default model", "Fast", "Standard", "Deep", "Visual", "Image generation"]) {
      expect(await r.findByRole("combobox", { name: `${role} model` })).toBeTruthy();
    }
    const deep = r.getByRole("combobox", { name: "Deep model" }) as HTMLSelectElement;
    fireEvent.change(deep, { target: { value: "chatgpt:gpt-6-astra" } });
    await waitFor(async () => expect((await r.api.getTaskModels()).find((t) => t.role === "deep")?.modelId).toBe("chatgpt:gpt-6-astra"));
    const image = r.getByRole("combobox", { name: "Image generation model" }) as HTMLSelectElement;
    expect([...image.options].map((o) => o.textContent)).toEqual(["ChatGPT Images"]);
    fireEvent.change(r.getByRole("combobox", { name: "Fast effort" }), { target: { value: "high" } });
    await waitFor(async () => expect((await r.api.getTaskModels()).find((t) => t.role === "fast")?.effort).toBe("high"));
  });
});
