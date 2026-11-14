import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { Welcome } from "../../src/pages/welcome/Welcome";
import { renderWithApi } from "./render";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

type R = ReturnType<typeof renderWithApi>;
/** The finish row's buttons; the import wizard has a Continue of its own. */
const row = () => within(document.querySelector<HTMLElement>(".wl-finish")!);
const heading = (r: R, name: string) => r.findByRole("heading", { level: 1, name });

async function toPlan(r: R) {
  fireEvent.click(await r.findByRole("button", { name: "Get started" }));
  await heading(r, "Connect your plan");
}

async function connectGrok(r: R) {
  fireEvent.click(await r.findByRole("button", { name: "Sign in to Grok" }));
  await waitFor(() => expect(r.getByText("Connected · neel@example.com", { selector: "#prov-grok .status" })).toBeTruthy());
}

async function importChrome(r: R) {
  fireEvent.click(await r.findByRole("radio", { name: /Chrome/ }));
  fireEvent.click(r.getAllByRole("button", { name: "Continue" })[0]!);
  await r.findByRole("group", { name: "What to bring from Chrome" });
  fireEvent.click(r.getAllByRole("button", { name: "Continue" })[0]!);
  fireEvent.click(await r.findByRole("button", { name: "Start import" }));
  expect(await r.findByRole("heading", { level: 3, name: "Import finished" })).toBeTruthy();
}

describe("Welcome", () => {
  test("setup is a few steps in one tab, and a plan is required before going on", async () => {
    const r = renderWithApi(<Welcome />, { signedOut: true });
    expect(await heading(r, "Welcome to Perch")).toBeTruthy();
    await toPlan(r);
    expect(r.getByRole("list", { name: "Step 1 of 5" })).toBeTruthy();
    const next = row().getByRole("button", { name: "Continue" }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    expect(r.getByText("Sign in to Claude, ChatGPT or Grok to continue.")).toBeTruthy();
    await connectGrok(r);
    await waitFor(() => expect(next.disabled).toBe(false));
  });

  test("skipping the import and agents, then Finish setup opens the tour with no memory build", async () => {
    const r = renderWithApi(<Welcome />);
    await toPlan(r);
    await connectGrok(r);
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await heading(r, "Bring everything over");
    fireEvent.click(row().getByRole("button", { name: "Skip for now" }));
    await heading(r, "Connect your password manager");
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await heading(r, "Let your coding agents use Perch");
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await heading(r, "Make it yours");
    fireEvent.click(r.getByRole("radio", { name: "Dusk" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dusk"));
    fireEvent.click(row().getByRole("button", { name: "Finish setup" }));
    await waitFor(async () => expect((await r.api.getOnboarding()).finished).toBe(true));
    expect(r.nav.some((n) => n.what === "background-tab")).toBe(false);
    expect(r.nav.at(-1)).toEqual({ what: "page", detail: { page: "tour", section: undefined } });
    expect((await r.api.getOnboarding()).done).toEqual(["models", "appearance"]);
  });

  test("after an import, memory builds in a chat in a background tab and the tour says so", async () => {
    const r = renderWithApi(<Welcome />);
    await toPlan(r);
    await connectGrok(r);
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await importChrome(r);
    expect((r.getByRole("checkbox", { name: /Build my memory from what came over/ }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await heading(r, "Connect your password manager");
    expect(await r.findByText(/Sign in with 1Password/)).toBeTruthy();
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await heading(r, "Let your coding agents use Perch");
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await heading(r, "Make it yours");
    fireEvent.click(row().getByRole("button", { name: "Finish setup" }));
    await waitFor(() => expect(r.nav.at(-1)).toEqual({ what: "page", detail: { page: "tour", section: "memory" } }));
    expect(r.nav.some((n) => n.what === "background-tab")).toBe(true);
    expect((await r.api.getOnboarding()).done).toEqual(["models", "import", "appearance", "memory"]);
  });

  test("Back steps back, and back to the start", async () => {
    const r = renderWithApi(<Welcome />);
    await toPlan(r);
    fireEvent.click(row().getByRole("button", { name: "Back" }));
    expect(await heading(r, "Welcome to Perch")).toBeTruthy();
  });

  test("Claude's sign-in finishes with the pasted code when the browser can't read it itself", async () => {
    const r = renderWithApi(<Welcome />);
    await toPlan(r);
    fireEvent.click(await r.findByRole("button", { name: "Sign in to Claude" }));
    const field = await r.findByLabelText("Paste the code Claude shows after you approve");
    fireEvent.input(field, { target: { value: "abc#def" } });
    fireEvent.submit(field.closest("form")!);
    await waitFor(async () => expect((await r.api.listProviders()).find((p) => p.id === "claude")?.state).toBe("connected"));
  });

  test("after a restart (Full Disk Access) setup opens on the step it was on", async () => {
    const r = renderWithApi(<Welcome />);
    await toPlan(r);
    await connectGrok(r);
    fireEvent.click(row().getByRole("button", { name: "Continue" }));
    await heading(r, "Bring everything over");
    cleanup();
    const again = renderWithApi(<Welcome />);
    expect(await heading(again, "Bring everything over")).toBeTruthy();
  });
});
