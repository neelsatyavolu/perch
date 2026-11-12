import { afterEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { useState } from "preact/hooks";
import type { ChatSettings, TabInfo } from "../src/api/types";
import { Composer, type SendExtras } from "../src/components/composer";
import type { PageHost } from "../src/host/frame-host";

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
});
const settings: ChatSettings = { mode: "guard", model: "m", effort: "medium", scope: "agent" };
const tabs: TabInfo[] = [
  { id: "a", windowId: "w", title: "Flights to Tokyo", url: "https://flights.example/" },
  { id: "b", windowId: "w", title: "Inbox", url: "https://mail.example/" },
];

/** A composer that keeps its own draft, like the pages do. */
function mount(host: PageHost | undefined, _frame: string | null = null, running = false, delivered = true) {
  const sent: { text: string; extras: SendExtras }[] = [];
  function Harness() {
    const [draft, setDraft] = useState("");
    return (
      <Composer
        draft={draft}
        onDraft={setDraft}
        onSend={async (text, extras) => {
          sent.push({ text, extras });
          return delivered;
        }}
        onStop={() => {}}
        running={running}
        tab={null}
        settings={settings}
        models={[]}
        onSettings={() => {}}
        host={host}
        listTabs={async () => tabs}
      />
    );
  }
  root = document.createElement("div");
  document.body.appendChild(root);
  act(() => render(<Harness />, root));
  return { el: root, sent };
}
const type = async (el: HTMLElement, value: string) => {
  const field = el.querySelector("textarea")!;
  field.value = value;
  await act(async () => void field.dispatchEvent(new Event("input", { bubbles: true })));
  await act(async () => await Bun.sleep(0));
};
const key = (el: HTMLElement, k: string) => act(() => void el.querySelector("textarea")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

test("attach shows the picked files and sends their ids; a file can be removed", async () => {
  const host: PageHost = { chooseFiles: async () => [{ id: "f1", name: "itinerary.pdf", size: 2048 }, { id: "f2", name: "photo.jpg", size: 10 }] };
  const { el, sent } = mount(host);
  const attach = el.querySelector('[aria-label="Attach files"]') as HTMLButtonElement;
  expect(attach.disabled).toBe(false);
  await act(async () => attach.click());
  await act(async () => await Bun.sleep(0));
  expect([...el.querySelectorAll(".chip.file .chip-t")].map((c) => c.textContent)).toEqual(["itinerary.pdf", "photo.jpg"]);
  await act(async () => (el.querySelector('[aria-label="Remove photo.jpg"]') as HTMLButtonElement).click());
  await type(el, "check this");
  key(el, "Enter");
  expect(sent).toEqual([{ text: "check this", extras: { files: [{ id: "f1", name: "itinerary.pdf", size: 2048 }], mentions: [] } }]);
  await act(async () => await Bun.sleep(0));
  expect(el.querySelector(".chip.file")).toBeNull();
});

test("a send that fails keeps the attached files for another try", async () => {
  const host: PageHost = { chooseFiles: async () => [{ id: "f1", name: "itinerary.pdf", size: 2048 }] };
  const { el, sent } = mount(host, null, false, false);
  await act(async () => (el.querySelector('[aria-label="Attach files"]') as HTMLButtonElement).click());
  await act(async () => await Bun.sleep(0));
  await type(el, "check this");
  key(el, "Enter");
  await act(async () => await Bun.sleep(0));
  expect(sent).toHaveLength(1);
  expect([...el.querySelectorAll(".chip.file .chip-t")].map((c) => c.textContent)).toEqual(["itinerary.pdf"]);
});

test("dictation stops when the composer goes away", async () => {
  let stopped = 0;
  const host: PageHost = { startDictation: async () => {}, stopDictation: async () => void stopped++ };
  const { el } = mount(host);
  await act(async () => (el.querySelector('[aria-label="Dictate"]') as HTMLButtonElement).click());
  act(() => render(null, root));
  expect(stopped).toBe(1);
});

test("dictation streams words into the draft after what was typed, and the button stops it", async () => {
  let speak: ((text: string, final: boolean) => void) | null = null;
  let stopped = 0;
  const host: PageHost = { startDictation: async (on) => void (speak = on), stopDictation: async () => void stopped++ };
  const { el } = mount(host);
  await type(el, "Book");
  await act(async () => (el.querySelector('[aria-label="Dictate"]') as HTMLButtonElement).click());
  expect(el.querySelector('[aria-label="Stop dictation"]')!.getAttribute("aria-pressed")).toBe("true");
  await act(async () => speak!("a table for two", false));
  expect(el.querySelector("textarea")!.value).toBe("Book a table for two");
  await act(async () => (el.querySelector('[aria-label="Stop dictation"]') as HTMLButtonElement).click());
  expect(stopped).toBe(1);
});

test("a refused dictation says why", async () => {
  const { el } = mount({ startDictation: async () => Promise.reject(new Error("Allow speech recognition for Perch in System Settings")) });
  await act(async () => (el.querySelector('[aria-label="Dictate"]') as HTMLButtonElement).click());
  await act(async () => await Bun.sleep(0));
  expect(el.querySelector(".cnote")!.textContent).toBe("Allow speech recognition for Perch in System Settings");
});

test("@ lists matching tabs; Enter picks one and the message sends it as a mention", async () => {
  const { el, sent } = mount(undefined);
  await type(el, "compare with @fli");
  const options = [...el.querySelectorAll('[aria-label="Tabs to mention"] [role="option"]')];
  expect(options.map((o) => o.querySelector(".opt-label")!.textContent)).toEqual(["Flights to Tokyo"]);
  key(el, "Enter");
  expect(el.querySelector("textarea")!.value).toBe("compare with @Flights to Tokyo ");
  expect(sent).toEqual([]);
  key(el, "Enter");
  expect(sent[0]!.extras.mentions.map((t) => t.id)).toEqual(["a"]);
});

