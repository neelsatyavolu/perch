import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { Settings } from "../../src/pages/settings/Settings";
import { createFakeApi } from "../../src/api/fake";
import { renderWithApi } from "./render";

beforeEach(() => void (window.location.hash = "#performance"));
afterEach(cleanup);

const neverSleep = () => document.getElementById("never-sleep")!;

describe("Performance", () => {
  test("changing the timeout saves it", async () => {
    const r = renderWithApi(<Settings />);
    const pick = (await r.findByRole("combobox", { name: "Sleep tabs after" })) as HTMLSelectElement;
    expect(pick.value).toBe("15");
    expect([...pick.options].map((o) => o.textContent)).toEqual(["Off", "5 minutes", "15 minutes", "30 minutes", "1 hour", "2 hours", "4 hours"]);
    fireEvent.change(pick, { target: { value: "60" } });
    await waitFor(async () => expect((await r.api.getMemorySaver()).timeoutMinutes).toBe(60));
    fireEvent.change(pick, { target: { value: "0" } });
    await waitFor(async () => expect((await r.api.getMemorySaver()).timeoutMinutes).toBe(0));
  });

  test("lists rules in their typed form with what they cover", async () => {
    const r = renderWithApi(<Settings />);
    expect(await r.findByText("=mail.example.com")).toBeTruthy();
    expect(r.getByText("Only this host")).toBeTruthy();
    expect(r.getByText("music.example.com")).toBeTruthy();
    expect(r.getByText("This site and its subdomains")).toBeTruthy();
  });

  test("adds a rule and shows the browser's refusal under the field", async () => {
    const r = renderWithApi(<Settings />);
    const field = (await r.findByRole("textbox", { name: "Site to keep awake" })) as HTMLInputElement;
    fireEvent.input(field, { target: { value: "localhost" } });
    fireEvent.click(r.getByRole("button", { name: "Add" }));
    expect((await r.findByRole("alert")).textContent).toBe("Use a domain like example.com, *.example.com, or a full URL.");
    expect(field.getAttribute("aria-invalid")).toBe("true");

    fireEvent.input(field, { target: { value: "*.docs.example.com" } });
    fireEvent.click(r.getByRole("button", { name: "Add" }));
    expect(await within(neverSleep()).findByText("*.docs.example.com")).toBeTruthy();
    expect(within(neverSleep()).getByText("Subdomains, not the site itself")).toBeTruthy();
    expect(r.queryByRole("alert")).toBeNull();
    expect(field.value).toBe("");
    expect((await r.api.getMemorySaver()).rules).toContainEqual({ kind: "wildcard", pattern: "docs.example.com" });
  });

  test("removes a rule", async () => {
    const r = renderWithApi(<Settings />);
    fireEvent.click(await r.findByRole("button", { name: "Remove =mail.example.com" }));
    await waitFor(() => expect(r.queryByText("=mail.example.com")).toBeNull());
    expect((await r.api.getMemorySaver()).rules).toEqual([{ kind: "domain", pattern: "music.example.com" }]);
  });

  test("lists tab memory largest first, sleeping tabs as Asleep, with a total", async () => {
    const r = renderWithApi(<Settings />);
    await r.findByText("Weekend playlist");
    const rows = [...document.getElementById("tab-memory")!.querySelectorAll(".srow")].map((row) => row.textContent);
    expect(rows).toEqual([
      "Weekend playlist241.8 MB",
      "Inbox (12) - Example Mail182.4 MB",
      "perch/ui-pages at main96.3 MB",
      "Quarterly plan - Example DocsAsleep",
      "Morning headlinesAsleep",
      "Total520.5 MB",
    ]);
  });

  test("Refresh loads the list again", async () => {
    const base = createFakeApi({ stepMs: 0 });
    let calls = 0;
    const api = { ...base, listTabMemory: async () => (++calls === 1 ? [] : base.listTabMemory()) };
    const r = renderWithApi(<Settings />, { api });
    expect(await r.findByText("No tabs are open.")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Refresh" }));
    expect(await r.findByText("Weekend playlist")).toBeTruthy();
  });

  test("a policy locks memory saver", async () => {
    const r = renderWithApi(<Settings />, { policy: { BuiltInExtensions: { memorySaver: true } } });
    const pick = (await r.findByRole("combobox", { name: "Sleep tabs after" })) as HTMLSelectElement;
    await waitFor(() => expect(pick.disabled).toBe(true));
    expect(r.getAllByText("Managed by your organization").length).toBe(2);
    expect(((r.getByRole("button", { name: "Add" })) as HTMLButtonElement).disabled).toBe(true);
    expect(((r.getByRole("button", { name: "Remove =mail.example.com" })) as HTMLButtonElement).disabled).toBe(true);
    await expect(r.api.setMemorySaver({ timeoutMinutes: 5 })).rejects.toThrow("Managed by your organization");
  });

  test("the fake refuses timeouts out of range", async () => {
    const api = createFakeApi({ stepMs: 0 });
    await expect(api.setMemorySaver({ timeoutMinutes: 1441 })).rejects.toThrow();
    await expect(api.setMemorySaver({ timeoutMinutes: -1 })).rejects.toThrow();
    await expect(api.addSleepRule("")).rejects.toThrow("Use a domain like example.com");
    expect((await api.addSleepRule("https://example.com/a/")).rules.at(-1)).toEqual({ kind: "prefix", pattern: "https://example.com/a" });
    expect((await api.addSleepRule("https://www.example.org")).rules.at(-1)).toEqual({ kind: "host", pattern: "example.org" });
    expect((await api.addSleepRule("example.com/docs")).rules.at(-1)).toEqual({ kind: "prefix", pattern: "example.com/docs" });
  });
});
