import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import { TourPage } from "../../src/pages/tour/Tour";
import { renderWithApi } from "./render";

afterEach(cleanup);
beforeEach(() => {
  window.location.hash = "";
  localStorage.clear();
});

describe("Tour", () => {
  test("four steps, opening on the side chat; #memory says memory is building in its own tab", async () => {
    window.location.hash = "#memory";
    const r = renderWithApi(<TourPage />);
    expect(await r.findByRole("heading", { level: 1, name: "Get to know Perch" })).toBeTruthy();
    expect(r.getByRole("button", { name: /Ask the side chat/ }).getAttribute("aria-expanded")).toBe("true");
    expect(r.getByText("0 of 4 done")).toBeTruthy();
    expect(r.getByText(/building your memory in the “Build my memory” tab/)).toBeTruthy();
  });

  test("asking from a step starts a chat beside the tour, and the step ticks off when the chat moves", async () => {
    const r = renderWithApi(<TourPage />);
    fireEvent.click(await r.findByRole("button", { name: /Ask the side chat/ }));
    fireEvent.click(await r.findByRole("button", { name: "Ask “What can you do?”" }));
    await waitFor(() => expect(r.nav.some((n) => n.what === "query" && (n.detail as { mode: string }).mode === "ask")).toBe(true));
    await waitFor(() => expect(r.getByText("1 of 4 done")).toBeTruthy(), { timeout: 4000 });
    expect(r.getByRole("button", { name: /Hand it a task/ }).getAttribute("aria-expanded")).toBe("true");
  });

  test("the command bar step opens the real command bar", async () => {
    const r = renderWithApi(<TourPage />);
    fireEvent.click(await r.findByRole("button", { name: /Find anything with the command bar/ }));
    fireEvent.click(await r.findByRole("button", { name: "Open the command bar" }));
    await waitFor(() => expect(r.nav.some((n) => n.what === "open-command-bar")).toBe(true));
    expect(await r.findByText("1 of 4 done")).toBeTruthy();
  });


});
