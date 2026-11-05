import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { Settings } from "../../src/pages/settings/Settings";
import { renderWithApi } from "./render";

afterEach(cleanup);

const at = (hash: string) => {
  window.location.hash = hash;
  return renderWithApi(<Settings />);
};

describe("Skills and MCP", () => {
  beforeEach(() => void (window.location.hash = ""));

  test("lists servers with how they run and switches them", async () => {
    const r = at("#skills");
    expect(await r.findByText("stdio · from Claude Code · 9 tools, 4 read only · asks before changes")).toBeTruthy();
    fireEvent.click(r.getByRole("switch", { name: "Use filesystem" }));
    await waitFor(async () => expect((await r.api.listMcpServers()).find((s) => s.name === "filesystem")?.enabled).toBe(true));
  });

  test("import shows a preview per app, skips servers already added, and imports the picked ones", async () => {
    const r = at("#skills");
    fireEvent.click(await r.findByRole("button", { name: "Import from Claude Code, Codex, Claude Desktop, Cursor and Grok" }));
    const dlg = await r.findByRole("dialog", { name: "Import MCP servers" });
    expect(await within(dlg).findByText(/to Keychain: DATABASE_URL/)).toBeTruthy();
    expect(within(dlg).getByRole("group", { name: "Cursor" })).toBeTruthy();
    const consult = within(dlg).getByRole("checkbox", { name: /consult/ }) as HTMLInputElement;
    expect(consult.disabled).toBe(true);
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /web-search/ }));
    fireEvent.click(within(dlg).getByRole("checkbox", { name: /linear/ }));
    fireEvent.click(within(dlg).getByRole("button", { name: "Import 2 servers" }));
    expect(await r.findByText(/^http · from Claude Code/)).toBeTruthy();
    const names = (await r.api.listMcpServers()).map((s) => s.name);
    expect(names).toContain("github");
    expect(names).toContain("postgres");
    expect(names).not.toContain("linear");
  });

  test("adding a server checks the address and keeps secret values out of the page", async () => {
    const r = at("#skills");
    fireEvent.click(await r.findByRole("button", { name: "Add a server" }));
    const dlg = await r.findByRole("dialog", { name: "Add an MCP server" });
    fireEvent.input(within(dlg).getByLabelText("Name"), { target: { value: "notes" } });
    fireEvent.click(within(dlg).getByRole("radio", { name: "HTTP" }));
    fireEvent.input(within(dlg).getByLabelText("Address"), { target: { value: "http://example.com/mcp" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add server" }));
    expect(await within(dlg).findByText("Use https for a server that isn't on this Mac")).toBeTruthy();
    fireEvent.input(within(dlg).getByLabelText("Address"), { target: { value: "https://notes.example.com/mcp" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add a header" }));
    fireEvent.input(within(dlg).getByLabelText("Name 1"), { target: { value: "Authorization" } });
    fireEvent.input(within(dlg).getByLabelText("Value 1"), { target: { value: "Bearer tok-very-secret" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add server" }));
    expect(await r.findByRole("switch", { name: "Use notes" })).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("tok-very-secret");
  });

  test("skills: built-in list, add from a folder with a check", async () => {
    const r = at("#skills");
    fireEvent.click(await r.findByRole("button", { name: "Show list" }));
    expect(await r.findByRole("switch", { name: "Use the Gmail skill" })).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Add a skill from a folder, link or git repository" }));
    const dlg = await r.findByRole("dialog", { name: "Add a skill" });
    fireEvent.input(within(dlg).getByLabelText("Folder"), { target: { value: "skills/pdf" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add skill" }));
    expect(await within(dlg).findByText("Enter a folder path, like ~/skills/pdf")).toBeTruthy();
    fireEvent.input(within(dlg).getByLabelText("Folder"), { target: { value: "~/skills/receipts" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Add skill" }));
    expect(await r.findByRole("button", { name: "Remove receipts" })).toBeTruthy();
  });
});

describe("Permissions", () => {
  test("mode is a radio group; site rules validate and save", async () => {
    const r = at("#permissions");
    const guard = await r.findByRole("radio", { name: /Guard/ });
    expect(guard.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(guard, { key: "ArrowLeft" });
    await waitFor(async () => expect((await r.api.getPermissions()).mode).toBe("ask"));
    fireEvent.input(r.getByRole("textbox", { name: "Site" }), { target: { value: "not a site" } });
    fireEvent.click(r.getByRole("button", { name: "Add rule" }));
    expect(await r.findByText("A site can't contain spaces")).toBeTruthy();
    fireEvent.input(r.getByRole("textbox", { name: "Site" }), { target: { value: "*.mybank.com" } });
    fireEvent.click(r.getByRole("button", { name: "Add rule" }));
    expect(await r.findByRole("button", { name: "Remove the rule for *.mybank.com" })).toBeTruthy();
    fireEvent.change(r.getByRole("combobox", { name: "Mode for Codex (MCP)" }), { target: { value: "guard" } });
    await waitFor(async () => expect((await r.api.getPermissions()).clientRules.find((c) => c.id === "mcp-codex")?.mode).toBe("guard"));
  });
});

describe("Privacy and security", () => {
  test("switches save; encrypted DNS offers resolvers; forgetting a site asks first", async () => {
    const r = at("#privacy");
    fireEvent.click(await r.findByRole("switch", { name: "Reject cookie banners" }));
    await waitFor(async () => expect((await r.api.getPrivacy()).cookieBanners).toBe(false));
    fireEvent.change(r.getByRole("combobox", { name: "DNS resolver" }), { target: { value: "custom" } });
    const addr = await r.findByRole("textbox", { name: "Resolver address" });
    fireEvent.input(addr, { target: { value: "http://dns.example" } });
    fireEvent.click(r.getByRole("button", { name: "Save" }));
    expect(await r.findByText("Enter the resolver's https:// address")).toBeTruthy();
    fireEvent.click(r.getByRole("switch", { name: "Perch updates" }));
    await waitFor(async () => expect((await r.api.getPrivacy()).backgroundConnections.find((c) => c.id === "updates")?.enabled).toBe(false));
    fireEvent.click(r.getByRole("button", { name: "Forget github.com" }));
    const dlg = await r.findByRole("dialog", { name: "Forget github.com?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Forget site" }));
    await waitFor(() => expect(r.queryByRole("button", { name: "Forget github.com" })).toBeNull());
  });
});

describe("Memory, Routines, Import and About", () => {
  test("memory switches and the delete-all confirmation", async () => {
    const r = at("#memory");
    fireEvent.click(await r.findByRole("switch", { name: "Learn from browsing history" }));
    await waitFor(async () => expect((await r.api.getMemorySettings()).historyExtraction).toBe(true));
    fireEvent.click(r.getByRole("button", { name: "Delete all" }));
    fireEvent.click(within(await r.findByRole("dialog", { name: "Delete all memory?" })).getByRole("button", { name: "Delete all memory" }));
    await waitFor(async () => expect(await r.api.listMemoryPages()).toEqual([]));
  });

  test("import lists browsers and opens the wizard for one", async () => {
    const r = at("#import");
    fireEvent.click(await r.findByRole("button", { name: "Import from Chrome" }));
    await waitFor(() => expect(r.nav).toEqual([{ what: "page", detail: { page: "import", section: "chrome" } }]));
  });

  test("about shows versions and checks for updates", async () => {
    const r = at("#about");
    expect(await r.findByText("157.0.8103.38")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Check for updates" }));
    expect(await r.findByText("Perch is up to date")).toBeTruthy();
  });
});
