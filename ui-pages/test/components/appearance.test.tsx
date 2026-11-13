import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import { Appearance } from "../../src/pages/settings/Appearance";
import { renderWithApi } from "./render";

afterEach(cleanup);

test("Vertical tabs turns the browser's vertical tab strip on and off", async () => {
  const r = renderWithApi(<Appearance />);
  const toggle = await r.findByRole("switch", { name: "Vertical tabs" });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(toggle);
  await waitFor(async () => expect((await r.api.getAppearance()).verticalTabs).toBe(true));
  fireEvent.click(toggle);
  await waitFor(async () => expect((await r.api.getAppearance()).verticalTabs).toBe(false));
});
