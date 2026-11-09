import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render, within } from "@testing-library/preact";
import { useState } from "preact/hooks";
import type { ProviderId } from "../../src/api";
import { Dialog } from "../../src/ui/Dialog";
import { ProviderMark } from "../../src/ui/ProviderMark";
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

  function Opener() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>Open dialog</button>
        <button type="button">Behind</button>
        <Dialog open={open} title="Rename" onClose={() => setOpen(false)} footer={<button type="button">Save</button>}>
          <input aria-label="New name" />
        </Dialog>
      </>
    );
  }

  test("Tab and Shift+Tab wrap inside the dialog, so the page behind never gets focus", () => {
    const { getByRole } = render(<Opener />);
    fireEvent.click(getByRole("button", { name: "Open dialog" }));
    const dlg = getByRole("dialog", { name: "Rename" });
    const close = within(dlg).getByRole("button", { name: "Close" });
    const save = within(dlg).getByRole("button", { name: "Save" });
    save.focus();
    fireEvent.keyDown(save, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(save);
    const name = within(dlg).getByRole("textbox", { name: "New name" });
    name.focus();
    fireEvent.keyDown(name, { key: "Tab" });
    expect(document.activeElement).toBe(name);
  });

  test("closing returns focus to the button that opened it", () => {
    const { getByRole } = render(<Opener />);
    const opener = getByRole("button", { name: "Open dialog" });
    opener.focus();
    fireEvent.click(opener);
    within(getByRole("dialog", { name: "Rename" })).getByRole("textbox").focus();
    fireEvent.click(getByRole("button", { name: "Close" }));
    expect(document.activeElement).toBe(opener);
  });
});

describe("ProviderMark", () => {
  test("draws a mark for every provider, never a letter", () => {
    const ids: readonly ProviderId[] = ["claude-code", "chatgpt", "grok", "anthropic", "openai", "xai", "gemini", "openrouter", "local"];
    for (const id of ids) {
      const { container } = render(<ProviderMark id={id} />);
      const tile = container.querySelector(".tile")!;
      expect(tile.querySelector("svg")).not.toBeNull();
      expect(tile.textContent).toBe("");
      cleanup();
    }
  });
});
