import { afterEach, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor } from "@testing-library/preact";
import { ProfileSection } from "../../src/pages/settings/Profile";
import { renderWithApi } from "./render";

afterEach(cleanup);

test("the profile's name and icon can be changed in Settings", async () => {
  const r = renderWithApi(<ProfileSection />);
  const name = (await r.findByLabelText("Profile name")) as HTMLInputElement;
  expect(name.value).toBe("Your Perch");
  fireEvent.input(name, { target: { value: "School" } });
  fireEvent.blur(name);
  await waitFor(async () => expect((await r.api.getProfile()).name).toBe("School"));

  const icons = r.getAllByRole("radio");
  expect(icons.map((i) => i.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false"]);
  fireEvent.click(icons[2]!);
  await waitFor(async () => expect((await r.api.getProfile()).icon).toBe(29));
  await waitFor(() => expect(r.getAllByRole("radio")[2]!.getAttribute("aria-checked")).toBe("true"));
});

test("an empty name is put back, not saved", async () => {
  const r = renderWithApi(<ProfileSection />);
  const name = (await r.findByLabelText("Profile name")) as HTMLInputElement;
  fireEvent.input(name, { target: { value: "   " } });
  fireEvent.blur(name);
  await waitFor(() => expect(name.value).toBe("Your Perch"));
  expect((await r.api.getProfile()).name).toBe("Your Perch");
});
