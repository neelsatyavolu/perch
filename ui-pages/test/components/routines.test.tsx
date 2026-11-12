import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/preact";
import { RoutinesPage } from "../../src/pages/routines/RoutinesPage";
import { renderWithApi } from "./render";

afterEach(cleanup);

describe("Routines page", () => {
  test("lists routines with schedule, last run and state in words", async () => {
    const r = renderWithApi(<RoutinesPage />);
    expect(await r.findByRole("heading", { level: 1, name: "Routines" })).toBeTruthy();
    const item = (await r.findByRole("heading", { name: "Morning mail summary" })).closest("li")!;
    expect(within(item).getByText("Weekdays 08:00")).toBeTruthy();
    const watch = (await r.findByRole("heading", { name: "Watch SFO to HND" })).closest("li")!;
    expect(within(watch).getByText(/Last run failed/)).toBeTruthy();
    expect(within(watch).getByText("Paused")).toBeTruthy();
  });

  test("pause, run now and delete", async () => {
    const r = renderWithApi(<RoutinesPage />);
    fireEvent.click(await r.findByRole("switch", { name: "Run Week ahead on schedule" }));
    await waitFor(async () => expect((await r.api.listRoutines()).find((x) => x.id === "rt2")?.enabled).toBe(false));
    fireEvent.click(r.getByRole("button", { name: "Run Week ahead now" }));
    await waitFor(async () => expect((await r.api.listRoutines()).find((x) => x.id === "rt2")?.lastRun?.outcome).toBe("ok"));
    fireEvent.click(r.getByRole("button", { name: "Delete Week ahead" }));
    fireEvent.click(within(await r.findByRole("dialog", { name: "Delete Week ahead?" })).getByRole("button", { name: "Delete routine" }));
    await waitFor(() => expect(r.queryByRole("heading", { name: "Week ahead" })).toBeNull());
  });

  test("new routine: checks the fields, picks days and a time", async () => {
    const r = renderWithApi(<RoutinesPage />);
    fireEvent.click(await r.findByRole("button", { name: "New routine" }));
    const dlg = await r.findByRole("dialog", { name: "New routine" });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save routine" }));
    expect(await within(dlg).findByText("Give it a name")).toBeTruthy();
    fireEvent.input(within(dlg).getByLabelText("Name"), { target: { value: "Grades check" } });
    fireEvent.input(within(dlg).getByLabelText("What Perch should do"), { target: { value: "List new grades on Canvas" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Saturday" }));
    expect(within(dlg).getByRole("button", { name: "Saturday" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.input(within(dlg).getByLabelText("Time"), { target: { value: "19:30" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save routine" }));
    expect(await r.findByRole("heading", { name: "Grades check" })).toBeTruthy();
    const saved = (await r.api.listRoutines()).find((x) => x.title === "Grades check")!;
    expect(saved.schedule).toEqual({ kind: "daily", time: "19:30", days: ["mon", "tue", "wed", "thu", "fri", "sat"] });
  });

  test("edit switches a routine to every few hours", async () => {
    const r = renderWithApi(<RoutinesPage />);
    fireEvent.click(await r.findByRole("button", { name: "Edit Morning mail summary" }));
    const dlg = await r.findByRole("dialog", { name: "Edit routine" });
    fireEvent.click(within(dlg).getByRole("radio", { name: "Every few hours" }));
    fireEvent.input(within(dlg).getByLabelText("Hours between runs"), { target: { value: "6" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save routine" }));
    await waitFor(async () => expect((await r.api.listRoutines()).find((x) => x.id === "rt1")?.schedule).toEqual({ kind: "interval", hours: 6 }));
  });

  test("a new routine isn't offered an event trigger, which Perch can't run yet", async () => {
    const r = renderWithApi(<RoutinesPage />);
    expect(await r.findByText("When mail arrives matching “invoice”")).toBeTruthy();
    fireEvent.click(r.getByRole("button", { name: "New routine" }));
    const dlg = await r.findByRole("dialog", { name: "New routine" });
    expect(within(dlg).queryByRole("radio", { name: "When something happens" })).toBeNull();
    expect(within(dlg).getByRole("radio", { name: "Every few hours" })).toBeTruthy();
  });

  test("editing a trigger routine changes its trigger", async () => {
    const r = renderWithApi(<RoutinesPage />);
    fireEvent.click(await r.findByRole("button", { name: "Edit File invoices" }));
    const dlg = await r.findByRole("dialog", { name: "Edit routine" });
    expect(within(dlg).getByRole("radio", { name: "When something happens" }).getAttribute("aria-checked")).toBe("true");
    const match = within(dlg).getByLabelText("From or subject contains (optional)") as HTMLInputElement;
    expect(match.value).toBe("invoice");
    fireEvent.change(within(dlg).getByLabelText("What starts it"), { target: { value: "download-finished" } });
    fireEvent.click(within(dlg).getByRole("button", { name: "Save routine" }));
    await waitFor(async () => expect((await r.api.listRoutines()).find((x) => x.id === "rt4")?.schedule).toEqual({ kind: "trigger", event: "download-finished" }));
  });

  test("find routines to automate: each proposal is approved or dismissed one by one", async () => {
    const r = renderWithApi(<RoutinesPage />);
    fireEvent.click(await r.findByRole("button", { name: "Find routines to automate" }));
    const found = await r.findByRole("region", { name: "Tasks you repeat" });
    expect(within(found).getByText("You did this on 3 Fridays since Oct 10")).toBeTruthy();
    fireEvent.click(within(found).getByRole("button", { name: "Add Friday expense report" }));
    expect(await r.findByRole("heading", { name: "Friday expense report", level: 3 })).toBeTruthy();
    fireEvent.click(within(found).getByRole("button", { name: "Not now: Check Canvas for new grades" }));
    expect(await r.findByText("Nothing else to suggest right now. Perch looks again as you browse.")).toBeTruthy();
  });
});
