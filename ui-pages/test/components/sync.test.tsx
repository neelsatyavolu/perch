import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { Settings } from "../../src/pages/settings/Settings";
import { renderWithApi } from "./render";

beforeEach(() => void (window.location.hash = "#sync"));
afterEach(cleanup);

describe("Sync", () => {
  test("turning sync on shows a QR code and the code to type, then the devices once approved", async () => {
    const r = renderWithApi(<Settings />, { sync: "off" });
    fireEvent.click(await r.findByRole("button", { name: "Turn on sync" }));
    const qr = await r.findByRole("img", { name: "Pairing code as a QR code" });
    expect(qr.querySelector("path")!.getAttribute("d")!.length).toBeGreaterThan(100);
    expect(r.getByLabelText("Pairing code").textContent).toBe("K7QD-2M9X-HT4W");
    expect(r.getByText(/Waiting for the other device/)).toBeTruthy();
    // The fake approves on the second poll.
    expect(await r.findByText("Sync is on", {}, { timeout: 4000 })).toBeTruthy();
    expect(r.getByText("MacBook Pro (this Mac)")).toBeTruthy();
  }, 8000);

  test("lists devices; this Mac can't be removed, another can", async () => {
    const r = renderWithApi(<Settings />);
    const devices = () => document.getElementById("sync-devices")!;
    expect(await r.findByText("MacBook Pro (this Mac)")).toBeTruthy();
    expect(within(devices()).queryByRole("button", { name: "Remove MacBook Pro" })).toBeNull();
    fireEvent.click(within(devices()).getByRole("button", { name: "Remove Mac Studio" }));
    fireEvent.click(await r.findByRole("button", { name: "Remove device" }));
    await waitFor(() => expect(within(devices()).queryByText("Mac Studio")).toBeNull());
    expect((await r.api.getSync()).devices.map((d) => d.id)).toEqual(["dev_mac", "dev_cli"]);
  });

  test("turning sync off asks first", async () => {
    const r = renderWithApi(<Settings />);
    fireEvent.click(await r.findByRole("button", { name: "Turn off" }));
    expect(await r.findByText(/forgets its sync keys/)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Turn off sync" }));
    expect(await r.findByRole("button", { name: "Turn on sync" })).toBeTruthy();
    expect((await r.api.getSync()).on).toBe(false);
  });

  test("the recovery key shows only after a second step, and says so when the build can't", async () => {
    const r = renderWithApi(<Settings />);
    fireEvent.click(await r.findByRole("button", { name: "Show" }));
    expect(r.queryByLabelText("Your recovery key")).toBeNull();
    fireEvent.click(await r.findByRole("button", { name: "Show key" }));
    expect((await r.findByLabelText("Your recovery key")).textContent).toBe("7KQ2D-M9XHT-4WB3N-PZ6RC-V8JFA");
    cleanup();

    const u = renderWithApi(<Settings />, { recoveryKey: "unavailable" });
    fireEvent.click(await u.findByRole("button", { name: "Show" }));
    fireEvent.click(await u.findByRole("button", { name: "Show key" }));
    expect((await u.findByRole("alert")).textContent).toContain("can't show the recovery key");
  });

  test("a policy that turns sync off locks turning it on", async () => {
    const r = renderWithApi(<Settings />, { sync: "off", policy: { SyncEnabled: false } });
    const on = (await r.findByRole("button", { name: "Turn on sync" })) as HTMLButtonElement;
    await waitFor(() => expect(on.disabled).toBe(true));
    expect(r.getByText("Managed by your organization")).toBeTruthy();
  });
});
