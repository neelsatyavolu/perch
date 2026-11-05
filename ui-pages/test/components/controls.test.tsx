import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/preact";
import { useState } from "preact/hooks";
import { Dialog } from "../../src/ui/Dialog";
import { Segmented } from "../../src/ui/Segmented";
import { Switch } from "../../src/ui/Switch";
import { TabList } from "../../src/ui/TabList";

afterEach(cleanup);

describe("Switch", () => {
  test("is a labelled switch that toggles with click", () => {
    let value = false;
    const { getByRole } = render(<Switch label="Content blocker" checked={false} onChange={(v) => (value = v)} />);
    const sw = getByRole("switch", { name: "Content blocker" });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(value).toBe(true);
  });
});

describe("Segmented", () => {
  function Harness() {
    const [v, setV] = useState<"search" | "ask">("search");
    return <Segmented label="Mode" value={v} onChange={setV} options={[{ value: "search", label: "Search" }, { value: "ask", label: "Ask" }]} />;
  }
  test("radio group with roving focus and arrow keys", () => {
    const { getByRole } = render(<Harness />);
    const search = getByRole("radio", { name: "Search" });
    const ask = getByRole("radio", { name: "Ask" });
    expect(getByRole("radiogroup", { name: "Mode" })).toBeTruthy();
    expect(search.getAttribute("tabindex")).toBe("0");
    expect(ask.getAttribute("tabindex")).toBe("-1");
    fireEvent.keyDown(search, { key: "ArrowRight" });
    expect(ask.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(ask);
    fireEvent.keyDown(ask, { key: "ArrowRight" });
    expect(search.getAttribute("aria-checked")).toBe("true");
  });
});

describe("TabList", () => {
  test("tabs control their panel and move with arrow keys", () => {
    function H() {
      const [t, setT] = useState("chats");
      return (
        <>
          <TabList label="Recent" idPrefix="r" value={t} onChange={setT} tabs={[{ value: "chats", label: "Chats" }, { value: "routines", label: "Routines" }]} />
          <div role="tabpanel" id={`r-panel-${t}`} aria-labelledby={`r-tab-${t}`}>{t}</div>
        </>
      );
    }
    const { getByRole } = render(<H />);
    const chats = getByRole("tab", { name: "Chats" });
    expect(chats.getAttribute("aria-controls")).toBe("r-panel-chats");
    fireEvent.keyDown(chats, { key: "End" });
    expect(getByRole("tab", { name: "Routines" }).getAttribute("aria-selected")).toBe("true");
    expect(getByRole("tabpanel").textContent).toBe("routines");
  });
});

describe("Dialog", () => {
  test("opens modal, names itself and closes on cancel (Escape)", () => {
    let closed = 0;
    const { getByRole } = render(
      <Dialog open title="Add a server" onClose={() => closed++}>
        <input aria-label="Name" />
      </Dialog>,
    );
    const dlg = getByRole("dialog", { name: "Add a server" });
    expect(dlg).toBeTruthy();
    fireEvent(dlg, new Event("cancel", { cancelable: true }));
    expect(closed).toBe(1);
    fireEvent.click(getByRole("button", { name: "Close" }));
    expect(closed).toBe(2);
  });
});
