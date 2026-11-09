import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import type { PerchApi } from "../../src/api";
import { createFakeApi, type FakeOptions } from "../../src/api/fake";
import { RECOVERY_KEY } from "../../src/api/seed";
import { Settings } from "../../src/pages/settings/Settings";
import { Welcome } from "../../src/pages/welcome/Welcome";
import { renderWithApi } from "./render";

afterEach(cleanup);

/** Records what restoreFromRecoveryKey was asked to do. */
function spied(options: FakeOptions = {}) {
  const api = createFakeApi({ stepMs: 0, ...options });
  const calls: { recoveryKey: string; fromBackup: boolean; replaceData?: boolean }[] = [];
  const wrapped: PerchApi = {
    ...api,
    restoreFromRecoveryKey: (p) => {
      calls.push(p);
      return api.restoreFromRecoveryKey(p);
    },
  };
  return { api: wrapped, calls };
}

const backup = () => document.getElementById("backup")!;

async function openRestore(r: ReturnType<typeof renderWithApi>) {
  await r.findByRole("region", { name: "Backup and restore" });
  fireEvent.click(within(backup()).getByRole("button", { name: "Restore" }));
  return within(backup()).getByRole("textbox", { name: "Recovery key" });
}

const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });

describe("Settings › Backup and restore", () => {
  beforeEach(() => void (window.location.hash = "#privacy"));

  test("a wrong key is refused in plain words", async () => {
    const r = renderWithApi(<Settings />);
    type(await openRestore(r), "AAAAA-BBBBB");
    fireEvent.click(within(backup()).getAllByRole("button", { name: "Restore" }).at(-1)!);
    expect((await r.findByRole("alert")).textContent).toBe("That recovery key doesn't match this Perch data. Check it and try again.");
  });

  test("the right key restores; any case, spaces and no dashes are fine", async () => {
    const s = spied({ security: { needsRestore: true } });
    const r = renderWithApi(<Settings />, { api: s.api });
    const loose = RECOVERY_KEY.toLowerCase().replace(/-/g, " ");
    type(await openRestore(r), loose);
    fireEvent.click(within(backup()).getAllByRole("button", { name: "Restore" }).at(-1)!);
    expect(await r.findByText("Restored. Perch reloaded your data.")).toBeTruthy();
    expect(s.calls).toEqual([{ recoveryKey: loose, fromBackup: false, replaceData: false }]);
    expect((await s.api.getSecurity()).needsRestore).toBe(false);
  });

  test("Also restore from a backup file is passed through", async () => {
    const s = spied();
    const r = renderWithApi(<Settings />, { api: s.api });
    type(await openRestore(r), RECOVERY_KEY);
    fireEvent.click(within(backup()).getByRole("checkbox", { name: "Also restore from a backup file" }));
    fireEvent.click(within(backup()).getAllByRole("button", { name: "Restore" }).at(-1)!);
    await r.findByText("Restored. Perch reloaded your data.");
    expect(s.calls).toEqual([{ recoveryKey: RECOVERY_KEY, fromBackup: true, replaceData: false }]);
  });

  test("a backup made with another key asks before replacing the data here", async () => {
    const s = spied({ backupFile: "other-key" });
    const r = renderWithApi(<Settings />, { api: s.api });
    type(await openRestore(r), RECOVERY_KEY);
    fireEvent.click(within(backup()).getByRole("checkbox", { name: "Also restore from a backup file" }));
    fireEvent.click(within(backup()).getAllByRole("button", { name: "Restore" }).at(-1)!);
    expect((await r.findByRole("alert")).textContent).toContain("made with a different key");
    expect(within(backup()).queryByText("Restored. Perch reloaded your data.")).toBeNull();
    fireEvent.click(within(backup()).getByRole("button", { name: "Replace and restore" }));
    await r.findByText("Restored. Perch reloaded your data.");
    expect(s.calls.map((c) => c.replaceData)).toEqual([false, true]);
  });

  test("a cancelled file picker shows nothing", async () => {
    const s = spied({ backupFile: "cancelled" });
    const r = renderWithApi(<Settings />, { api: s.api });
    type(await openRestore(r), RECOVERY_KEY);
    fireEvent.click(within(backup()).getByRole("checkbox", { name: "Also restore from a backup file" }));
    fireEvent.click(within(backup()).getAllByRole("button", { name: "Restore" }).at(-1)!);
    await waitFor(() => expect(s.calls.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(backup()).queryByRole("status")).toBeNull();
    expect(within(backup()).queryByRole("alert")).toBeNull();
  });

  test("a damaged backup is named as such", async () => {
    const r = renderWithApi(<Settings />, { backupFile: "bad" });
    type(await openRestore(r), RECOVERY_KEY);
    fireEvent.click(within(backup()).getByRole("checkbox", { name: "Also restore from a backup file" }));
    fireEvent.click(within(backup()).getAllByRole("button", { name: "Restore" }).at(-1)!);
    expect((await r.findByRole("alert")).textContent).toBe("That file isn't a Perch backup, or it's damaged.");
  });

  test("Export everything says where it saved, and nothing when cancelled", async () => {
    const r = renderWithApi(<Settings />);
    await r.findByRole("region", { name: "Backup and restore" });
    fireEvent.click(within(backup()).getByRole("button", { name: "Export" }));
    expect((await within(backup()).findByRole("status")).textContent).toMatch(/^Saved Perch backup \d{4}-\d{2}-\d{2}\.perchbackup$/);
    cleanup();

    const c = renderWithApi(<Settings />, { exportBackup: "cancelled" });
    await c.findByRole("region", { name: "Backup and restore" });
    fireEvent.click(within(backup()).getByRole("button", { name: "Export" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(within(backup()).queryByRole("status")).toBeNull();
  });

  test("a failed export shows the error", async () => {
    const r = renderWithApi(<Settings />, { exportBackup: "failed" });
    await r.findByRole("region", { name: "Backup and restore" });
    fireEvent.click(within(backup()).getByRole("button", { name: "Export" }));
    expect((await within(backup()).findByRole("alert")).textContent).toBe("Perch couldn't write the backup.");
  });

  test("a build without Secure Enclave protection says so", async () => {
    const r = renderWithApi(<Settings />, { security: { protected: false } });
    await r.findByRole("region", { name: "Backup and restore" });
    expect(within(backup()).getByText("Keys are not protected by the Secure Enclave in this build")).toBeTruthy();
  });

  test("protected keys show no notice", async () => {
    const r = renderWithApi(<Settings />);
    await r.findByRole("region", { name: "Backup and restore" });
    expect(within(backup()).queryByText(/Secure Enclave/)).toBeNull();
  });

  test("without the key helper the rows explain why and are disabled", async () => {
    const r = renderWithApi(<Settings />, { security: { available: false, protected: false } });
    await r.findByRole("region", { name: "Backup and restore" });
    expect(within(backup()).getAllByText("This build of Perch has no key helper").length).toBe(2);
    expect((within(backup()).getByRole("button", { name: "Export" }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(backup()).getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(backup()).queryByText(/Secure Enclave/)).toBeNull();
  });
});

describe("Welcome › restore", () => {
  beforeEach(() => void (window.location.hash = ""));

  const LINE = "This Mac has your Perch data but not its key. Enter your recovery key to unlock it.";

  test("perch://welcome#restore shows the restore form, then setup after Continue", async () => {
    window.location.hash = "#restore";
    const r = renderWithApi(<Welcome />);
    expect(await r.findByText(LINE)).toBeTruthy();
    type(r.getByRole("textbox", { name: "Recovery key" }), RECOVERY_KEY);
    fireEvent.click(r.getByRole("button", { name: "Restore" }));
    expect(await r.findByText("Restored. Perch reloaded your data.")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "Continue" }));
    expect(await r.findByRole("heading", { level: 1, name: "Welcome to Perch" })).toBeTruthy();
  });

  test("shows the restore view when the browser reports data without a key", async () => {
    const r = renderWithApi(<Welcome />, { security: { needsRestore: true } });
    expect(await r.findByText(LINE)).toBeTruthy();
    type(r.getByRole("textbox", { name: "Recovery key" }), "nope");
    fireEvent.click(r.getByRole("button", { name: "Restore" }));
    expect((await r.findByRole("alert")).textContent).toBe("That recovery key doesn't match this Perch data. Check it and try again.");
  });

  test("without the recovery key, Start fresh sets the old data aside after a confirmation", async () => {
    const r = renderWithApi(<Welcome />, { security: { needsRestore: true } });
    expect(await r.findByText(LINE)).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "I don't have my recovery key" }));
    expect((await r.findByRole("alert")).textContent).toContain("moves the old data aside, untouched");
    fireEvent.click(r.getByRole("button", { name: "Start fresh" }));
    expect(await r.findByRole("heading", { level: 1, name: "Welcome to Perch" })).toBeTruthy();
    expect((await r.api.getSecurity()).needsRestore).toBe(false);
  });

  test("a normal first run goes straight to setup", async () => {
    const r = renderWithApi(<Welcome />);
    expect(await r.findByRole("heading", { level: 1, name: "Welcome to Perch" })).toBeTruthy();
    expect(r.queryByText(LINE)).toBeNull();
  });
});
