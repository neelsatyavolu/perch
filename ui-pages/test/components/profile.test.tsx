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

test("an uploaded picture shows in place of the icon; picking an icon or Remove puts the icon back", async () => {
  const r = renderWithApi(<ProfileSection />);
  await r.api.setProfilePicture("iVBORw0KGgo=");
  cleanup();
  const again = renderWithApi(<ProfileSection />, { api: r.api });
  await again.findByRole("button", { name: "Remove" });
  expect(again.getAllByRole("radio").every((i) => i.getAttribute("aria-checked") === "false")).toBe(true);
  fireEvent.click(again.getAllByRole("radio")[1]!);
  await waitFor(async () => expect((await r.api.getProfile()).picture).toBeNull());
  expect((await r.api.getProfile()).icon).toBe(28);
  await waitFor(() => expect(again.queryByRole("button", { name: "Remove" })).toBeNull());
});

test("a file that isn't a picture is refused with a reason", async () => {
  const { squarePng } = await import("../../src/pages/settings/Profile");
  await expect(squarePng(new Blob(["hi"], { type: "text/plain" }))).rejects.toThrow("Choose a picture");
  await expect(squarePng(new Blob([new Uint8Array(21 * 1024 * 1024)], { type: "image/png" }))).rejects.toThrow("over 20 MB");
});
