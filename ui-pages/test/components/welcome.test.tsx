import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import { Welcome } from "../../src/pages/welcome/Welcome";
import { renderWithApi } from "./render";

afterEach(cleanup);

describe("Welcome", () => {
  test("walks through look, models, import and memory, then opens a new tab", async () => {
    const r = renderWithApi(<Welcome />);
    expect(await r.findByRole("heading", { level: 1, name: "Welcome to Perch" })).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Set up Perch" }));

    expect(await r.findByRole("heading", { level: 1, name: "Pick a look" })).toBeTruthy();
    expect(r.getByText("Step 1 of 4")).toBeTruthy();
    fireEvent.click(r.getByRole("radio", { name: "Dusk" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dusk"));
    fireEvent.click(r.getByRole("button", { name: "Continue" }));

    expect(await r.findByRole("heading", { level: 1, name: "Connect a model" })).toBeTruthy();
    fireEvent.click(await r.findByRole("button", { name: "Sign in to Grok" }));
    await waitFor(() => expect(r.getByText("Connected · neel@example.com", { selector: "#prov-grok .status" })).toBeTruthy());
    fireEvent.click(r.getByRole("button", { name: "Continue" }));

    expect(await r.findByRole("heading", { level: 1, name: "Bring your tabs and bookmarks" })).toBeTruthy();
    fireEvent.click(await r.findByRole("button", { name: "Import from Chrome" }));
    await waitFor(() => expect(r.nav.some((n) => n.what === "page" && (n.detail as { page: string }).page === "import")).toBe(true));
    fireEvent.click(r.getByRole("button", { name: "Continue" }));

    expect(await r.findByRole("heading", { level: 1, name: "Set up your memory" })).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Not now" }));
    await waitFor(async () => expect((await r.api.getOnboarding()).finished).toBe(true));
    expect((await r.api.getOnboarding()).done).toEqual(["appearance", "models", "import"]);
    expect(r.nav.at(-1)).toEqual({ what: "page", detail: { page: "newtab", section: undefined } });
  });

  test("Skip setup finishes at once", async () => {
    const r = renderWithApi(<Welcome />);
    fireEvent.click(await r.findByRole("button", { name: "Skip setup" }));
    await waitFor(async () => expect((await r.api.getOnboarding()).finished).toBe(true));
  });
});
