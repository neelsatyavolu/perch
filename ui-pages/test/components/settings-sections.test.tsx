import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { Settings } from "../../src/pages/settings/Settings";
import { createFakeApi } from "../../src/api/fake";
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

  test("tokens inside MCP command lines and URLs never reach the page", async () => {
    const base = createFakeApi({ stepMs: 0 });
    const leaky = {
      ...base,
      listMcpServers: async () => [{ ...(await base.listMcpServers())[0]!, name: "leaky", target: "leaky-mcp --api-key raw-0000-secret" }],
    };
    window.location.hash = "#skills";
    const r = renderWithApi(<Settings />, { api: leaky });
    fireEvent.click(await r.findByRole("button", { name: "leaky options" }));
    const server = await r.findByRole("dialog", { name: "leaky" });
    expect(within(server).getByText("leaky-mcp --api-key ${API_KEY}")).toBeTruthy();
    fireEvent.click(within(server).getByRole("button", { name: "Done" }));

    fireEvent.click(r.getByRole("button", { name: "Import from Claude Code, Codex, Claude Desktop, Cursor and Grok" }));
    const dlg = await r.findByRole("dialog", { name: "Import MCP servers" });
    expect(await within(dlg).findByText(/sse\?api_key=\$\{API_KEY\}/)).toBeTruthy();
    expect(document.body.innerHTML).not.toContain("raw-0000-secret");
    expect(document.body.innerHTML).not.toContain("lin_api_");
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

describe("Activity log", () => {
  test("lists each agent action with client, site, tab and result, and exports", async () => {
    const r = at("#permissions");
    const log = await r.findByRole("region", { name: "Activity log" });
    const table = await within(log).findByRole("table", { name: "Agent actions, newest first" });
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.length).toBe(5);
    expect(rows[0]!.textContent).toContain("Clicked Send on a reply to Maya Chen");
    expect(rows[0]!.textContent).toContain("Approved");
    expect(within(table).getByText("Blocked by a site rule")).toBeTruthy();
    expect(within(table).getByText("Chase - Accounts")).toBeTruthy();
    const saved: Blob[] = [];
    const create = URL.createObjectURL;
    URL.createObjectURL = (blob: Blob) => (saved.push(blob), "blob:perch-test");
    try {
      fireEvent.click(within(log).getByRole("button", { name: "Export CSV" }));
      expect(await r.findByText(/^Saved 5 actions to perch-activity-.*\.csv$/)).toBeTruthy();
      expect(saved[0]!.type).toBe("text/csv");
      expect((await saved[0]!.text()).split("\r\n")[0]).toBe("at,client,tab,site,action,outcome");
      fireEvent.click(within(log).getByRole("button", { name: "Export JSON lines" }));
      expect(await r.findByText(/^Saved 5 actions to perch-activity-.*\.jsonl$/)).toBeTruthy();
    } finally {
      URL.createObjectURL = create;
    }
  });
});

describe("Settings under a company policy", () => {
  test("locked rows show their value, are disabled and say so; About links to the policies", async () => {
    window.location.hash = "#memory";
    const policy = { MemoryEnabled: false, AutoUpdateEnabled: false, BuiltInExtensions: { backrow: false } };
    const r = renderWithApi(<Settings />, { policy });
    const learn = (await r.findByRole("switch", { name: "Learn from chats" })) as HTMLButtonElement;
    await waitFor(() => expect(learn.disabled).toBe(true));
    expect(r.getAllByText("Managed by your organization").length).toBe(3);
    cleanup();
    window.location.hash = "#about";
    const about = renderWithApi(<Settings />, { policy });
    await waitFor(async () => expect(((await about.findByRole("switch", { name: "Update automatically" })) as HTMLButtonElement).disabled).toBe(true));
    expect((await about.findByRole("link", { name: "Open policies" })).getAttribute("href")).toBe("perch://policy");
    expect(about.getByText("Your organization manages some settings")).toBeTruthy();
  });

  test("an unmanaged Mac shows no managed rows", async () => {
    window.location.hash = "#about";
    const r = renderWithApi(<Settings />);
    expect(((await r.findByRole("switch", { name: "Update automatically" })) as HTMLButtonElement).disabled).toBe(false);
    expect(r.queryByText("Your organization manages some settings")).toBeNull();
    expect(r.queryByText("Managed by your organization")).toBeNull();
  });
});

describe("Permissions under a company cap", () => {
  test("neither the default mode nor an outside client can go above the cap", async () => {
    window.location.hash = "#permissions";
    const r = renderWithApi(<Settings />, { permissions: { maxMode: "guard" } });
    expect(((await r.findByRole("radio", { name: /Skip/ })) as HTMLButtonElement).disabled).toBe(true);
    const client = r.getByRole("combobox", { name: "Mode for perch CLI" }) as HTMLSelectElement;
    expect([...client.options].map((o) => o.value)).toEqual(["ask", "guard"]);
    expect(r.getByText(/Your organization allows up to Guard/)).toBeTruthy();
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
    expect(r.getByText("Lookups keep using Cloudflare until you save an address.")).toBeTruthy();
    expect((await r.api.getPrivacy()).dohProvider).toBe("cloudflare");
    fireEvent.click(r.getByRole("button", { name: "Save" }));
    expect(await r.findByText("Enter the resolver's https:// address")).toBeTruthy();
    expect((await r.api.getPrivacy()).dohProvider).toBe("cloudflare");
    fireEvent.input(addr, { target: { value: "https://dns.example/dns-query" } });
    fireEvent.click(r.getByRole("button", { name: "Save" }));
    await waitFor(async () => expect(await r.api.getPrivacy()).toMatchObject({ dohProvider: "custom", dohCustomUrl: "https://dns.example/dns-query" }));
    await waitFor(() => expect(r.queryByText("Lookups keep using Cloudflare until you save an address.")).toBeNull());
    fireEvent.click(r.getByRole("switch", { name: "Perch updates" }));
    await waitFor(async () => expect((await r.api.getPrivacy()).backgroundConnections.find((c) => c.id === "updates")?.enabled).toBe(false));
    fireEvent.click(r.getByRole("button", { name: "Forget github.com" }));
    const dlg = await r.findByRole("dialog", { name: "Forget github.com?" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Forget site" }));
    await waitFor(() => expect(r.queryByRole("button", { name: "Forget github.com" })).toBeNull());
  });
});

describe("Memory, Routines, Import and About", () => {
  test("the overnight tidy log lists each pass by date with what it changed", async () => {
    const r = at("#memory");
    fireEvent.click(await r.findByRole("button", { name: "Read the log" }));
    const dlg = await r.findByRole("dialog", { name: "Overnight tidy log" });
    expect(await within(dlg).findByText("Merged two pages about Maya Chen")).toBeTruthy();
    expect(within(dlg).getByText("2 merges · 5 facts updated · 1 moved to History")).toBeTruthy();
    expect(within(dlg).getAllByRole("heading", { level: 3 }).length).toBe(2);
  });

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
