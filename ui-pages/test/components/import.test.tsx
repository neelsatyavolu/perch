import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { createFakeApi } from "../../src/api/fake";
import { ImportWizard } from "../../src/pages/import/ImportWizard";
import { renderWithApi } from "./render";

afterEach(cleanup);
beforeEach(() => void (window.location.hash = ""));

describe("Import wizard", () => {
  test("pick a browser, pick data, see what needs permission first, then import", async () => {
    const r = renderWithApi(<ImportWizard />);
    expect(await r.findByRole("heading", { level: 1, name: "Import from another browser" })).toBeTruthy();
    fireEvent.click(await r.findByRole("radio", { name: /Chrome/ }));
    // Chrome has two profiles: swap the first for the second.
    const profiles = r.getByRole("group", { name: "Profiles to bring from Chrome" });
    fireEvent.click(within(profiles).getByRole("checkbox", { name: "Neel" }));
    fireEvent.click(within(profiles).getByRole("checkbox", { name: "School" }));
    fireEvent.click(r.getByRole("button", { name: "Continue" }));

    const data = await r.findByRole("group", { name: "What to bring from Chrome" });
    expect(within(data).getByRole("checkbox", { name: /Bookmarks/ })).toBeTruthy();
    fireEvent.click(within(data).getByRole("checkbox", { name: /History/ }));
    fireEvent.click(within(data).getByRole("checkbox", { name: /Extensions/ }));
    fireEvent.click(within(data).getByRole("checkbox", { name: /Search engine and settings/ }));
    fireEvent.click(r.getByRole("button", { name: "Continue" }));

    expect(await r.findByText("macOS asks to unlock Chrome's Keychain item. Choose Allow to let Perch read it once.")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Start import" }));
    expect(await r.findByRole("heading", { name: "Import finished" })).toBeTruthy();
    expect(r.getByText("41 tabs, asleep until you open them")).toBeTruthy();
    expect(r.getByText("Passwords")).toBeTruthy();
  });

  test("several profiles import together, each summary line named after its profile", async () => {
    const r = renderWithApi(<ImportWizard />);
    fireEvent.click(await r.findByRole("radio", { name: /Chrome/ }));
    const profiles = r.getByRole("group", { name: "Profiles to bring from Chrome" });
    expect((within(profiles).getByRole("checkbox", { name: "Neel" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(profiles).getByRole("checkbox", { name: "School" }));
    fireEvent.click(r.getByRole("button", { name: "Continue" }));
    const data = await r.findByRole("group", { name: "What to bring from Chrome" });
    for (const box of within(data).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked && !/Bookmarks/.test(box.parentElement!.textContent!)) fireEvent.click(box);
    fireEvent.click(r.getByRole("button", { name: "Continue" }));
    expect(await r.findByRole("heading", { name: "Import finished" })).toBeTruthy();
    expect(r.getByText(/^Neel: .*bookmarks/)).toBeTruthy();
    expect(r.getByText(/^School: .*bookmarks/)).toBeTruthy();
  });

  test("no profile ticked means no Continue", async () => {
    const r = renderWithApi(<ImportWizard />);
    fireEvent.click(await r.findByRole("radio", { name: /Chrome/ }));
    fireEvent.click(within(r.getByRole("group", { name: "Profiles to bring from Chrome" })).getByRole("checkbox", { name: "Neel" }));
    expect((r.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("the browser listed first, the one used most recently, starts picked", async () => {
    const r = renderWithApi(<ImportWizard />);
    const radios = await r.findAllByRole("radio");
    await waitFor(() => expect((radios[0] as HTMLInputElement).checked).toBe(true));
    expect((r.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("the hash preselects a browser; Aside extras are listed separately", async () => {
    window.location.hash = "#aside";
    const r = renderWithApi(<ImportWizard />);
    const data = await r.findByRole("group", { name: "What to bring from Aside" });
    expect(within(data).getByRole("checkbox", { name: /Aside memory/ })).toBeTruthy();
    expect(within(data).getByText("From Aside only")).toBeTruthy();
    expect(r.getByText("Model sign-ins are not copied. You sign in again in Settings, so tokens never move between apps.")).toBeTruthy();
  });

  test("Safari: steps that need Full Disk Access say so before asking", async () => {
    window.location.hash = "#safari";
    const r = renderWithApi(<ImportWizard />);
    await r.findByRole("group", { name: "What to bring from Safari" });
    fireEvent.click(r.getByRole("button", { name: "Continue" }));
    expect(await r.findByText(/Safari keeps its data where only apps with Full Disk Access can read it/)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Open System Settings" }));
    await waitFor(() => expect(r.nav.some((n) => n.what === "system-settings")).toBe(true));
  });

  test("Safari passwords: the exported file is chosen before the import can start", async () => {
    window.location.hash = "#safari";
    const r = renderWithApi(<ImportWizard />, { access: { fullDiskAccess: true } });
    const data = await r.findByRole("group", { name: "What to bring from Safari" });
    for (const box of within(data).getAllByRole("checkbox")) if (!/Passwords/.test(box.parentElement!.textContent!)) fireEvent.click(box);
    fireEvent.click(r.getByRole("button", { name: "Continue" }));
    const start = (await r.findByRole("button", { name: "Start import" })) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(r.getByRole("button", { name: "Choose exported file" }));
    expect(await r.findByText("Passwords.csv")).toBeTruthy();
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(await r.findByRole("heading", { name: "Import finished" })).toBeTruthy();
  });

  test("a failed import says why and offers Back and Try again", async () => {
    window.location.hash = "#chrome";
    const r = renderWithApi(<ImportWizard />, { failJobs: "Chrome is open and has its files locked. Quit Chrome and try again." });
    const data = await r.findByRole("group", { name: "What to bring from Chrome" });
    for (const box of within(data).getAllByRole("checkbox")) if (!/Bookmarks/.test(box.parentElement!.textContent!)) fireEvent.click(box);
    fireEvent.click(r.getByRole("button", { name: "Continue" }));
    expect(await r.findByRole("heading", { name: "Import stopped" })).toBeTruthy();
    expect(r.getByRole("alert").textContent).toContain("Quit Chrome and try again.");
    fireEvent.click(r.getByRole("button", { name: "Try again" }));
    expect(await r.findByRole("heading", { name: "Import stopped" })).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Back" }));
    expect(await r.findByRole("group", { name: "What to bring from Chrome" })).toBeTruthy();
  });

  test("before the first progress event the import step says it is starting", async () => {
    window.location.hash = "#chrome";
    const silent = { ...createFakeApi({ stepMs: 0 }), watchJob: () => () => undefined };
    const r = renderWithApi(<ImportWizard />, { api: silent });
    const data = await r.findByRole("group", { name: "What to bring from Chrome" });
    for (const box of within(data).getAllByRole("checkbox")) if (!/Bookmarks/.test(box.parentElement!.textContent!)) fireEvent.click(box);
    fireEvent.click(r.getByRole("button", { name: "Continue" }));
    expect(await r.findByText("Starting the import")).toBeTruthy();
  });

  test("nothing picked means no import", async () => {
    window.location.hash = "#chrome";
    const r = renderWithApi(<ImportWizard />);
    const data = await r.findByRole("group", { name: "What to bring from Chrome" });
    for (const box of within(data).getAllByRole("checkbox")) if ((box as HTMLInputElement).checked) fireEvent.click(box);
    expect((r.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
