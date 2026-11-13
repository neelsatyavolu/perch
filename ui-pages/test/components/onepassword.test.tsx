import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { OnePasswordGroup } from "../../src/pages/settings/OnePassword";
import { renderWithApi } from "./render";

afterEach(cleanup);

const PERSONAL = "FAKEUSER0000000000000001";
const WORK = "FAKEUSER0000000000000002";

test("turning 1Password on uses the first account; each account has its own switch", async () => {
  const r = renderWithApi(<OnePasswordGroup />);
  const toggle = await r.findByRole("switch", { name: "Sign in with 1Password" });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect((await r.api.getOnePassword()).chosen).toEqual([{ account: PERSONAL, vaults: null }]);

  fireEvent.click(await r.findByRole("switch", { name: "Use you@work.example" }));
  await waitFor(async () => expect((await r.api.getOnePassword()).chosen).toEqual([{ account: PERSONAL, vaults: null }, { account: WORK, vaults: null }]));

  fireEvent.click(toggle);
  await waitFor(async () => expect((await r.api.getOnePassword()).chosen).toEqual([]));
});

test("Choose vaults lists the account's vaults; unticking one leaves the agent the rest", async () => {
  const r = renderWithApi(<OnePasswordGroup />);
  fireEvent.click(await r.findByRole("switch", { name: "Sign in with 1Password" }));
  fireEvent.click(await r.findByRole("radio", { name: "Choose vaults" }));
  const vaults = await r.findByRole("group", { name: "Vaults the agent may use in you@example.com" });
  await waitFor(() => expect(within(vaults).getAllByRole("checkbox")).toHaveLength(2));
  fireEvent.click(within(vaults).getByRole("checkbox", { name: "Work" }));
  await waitFor(async () => expect((await r.api.getOnePassword()).chosen).toEqual([{ account: PERSONAL, vaults: ["privatevault00000000000000"] }]));
  // The last vault can't be unticked: turn the account off instead.
  expect((within(vaults).getByRole("checkbox", { name: "Private" }) as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(r.getByRole("radio", { name: "All vaults" }));
  await waitFor(async () => expect((await r.api.getOnePassword()).chosen).toEqual([{ account: PERSONAL, vaults: null }]));
});
