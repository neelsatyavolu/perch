import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import { OnePasswordGroup } from "../../src/pages/settings/OnePassword";
import { renderWithApi } from "./render";

afterEach(cleanup);

test("the 1Password switch turns sign-in with 1Password on and off", async () => {
  const r = renderWithApi(<OnePasswordGroup />);
  const toggle = await r.findByRole("switch", { name: "Sign in with 1Password" });
  await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  expect((await r.api.getOnePassword()).account).toBe("FAKEUSER0000000000000001");
  expect(r.getByText(/You approve with Touch ID/)).toBeTruthy();
  fireEvent.click(toggle);
  await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
});
