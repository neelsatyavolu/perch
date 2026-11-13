import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import { About } from "../../src/pages/settings/About";
import { renderWithApi } from "./render";

afterEach(cleanup);

test("an update downloaded in the background shows as ready, and Restart installs it", async () => {
  const r = renderWithApi(<About />, { about: { updateReady: "0.1.6" } });
  expect(await r.findByText("Perch 0.1.6 is ready. Restart to finish.")).toBeTruthy();
  fireEvent.click(r.getByRole("button", { name: "Restart Perch" }));
  await waitFor(() => expect(r.nav).toContainEqual({ what: "restart", detail: "0.1.6" }));
});

test("without a downloaded update, About offers a check", async () => {
  const r = renderWithApi(<About />);
  expect(await r.findByRole("button", { name: "Check for updates" })).toBeTruthy();
  expect(r.getByText(/every few hours/)).toBeTruthy();
});
