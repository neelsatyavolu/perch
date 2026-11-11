import { afterEach, expect, mock, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { ApprovalCard as Card, ChatMessage, ChatSettings, ModelInfo } from "../src/api/types";
import { ApprovalCard } from "../src/components/approval";
import { clampWidth, parseCsv, PANE } from "../src/components/artifact-pane";
import { ago, ChatList } from "../src/components/chat-list";
import { Composer, PLACEHOLDER } from "../src/components/composer";
import { fitEffort, matchModels } from "../src/components/model-menu";
import { PerchDot } from "../src/components/icon";
import { memo } from "../src/components/memo";
import { LiveRun, Message, Steps } from "../src/components/message";
import { providerPath } from "../src/components/provider-mark";
import { resolveTheme } from "../src/theme/theme";

let root: HTMLElement;
afterEach(() => {
  render(null, root);
  root.remove();
});
function mount(node: preact.VNode): HTMLElement {
  root = document.createElement("div");
  document.body.appendChild(root);
  act(() => render(node, root));
  return root;
}
const click = (el: Element | null) => act(() => (el as HTMLElement).click());

const card: Card = { id: "p1", chatId: "c", runId: "r", title: 'Type into textbox "Message" and press Enter', site: "mail.example", kind: "risky", body: "Hi Maya, Thursday works.", confirm: "Type and press Enter", danger: false };

test("the approval card shows what goes out and its button names the action", async () => {
  const decide = mock(async (_: boolean) => {});
  const el = mount(<ApprovalCard card={card} onDecide={decide} />);
  expect(el.querySelector(".body")!.textContent).toBe("Hi Maya, Thursday works.");
  expect(el.querySelector(".meta")!.textContent).toContain("mail.example");
  const buttons = [...el.querySelectorAll("button")];
  expect(buttons.map((b) => b.textContent)).toEqual(["Type and press Enter", "Don't allow"]);
  expect(buttons.some((b) => /^(ok|confirm)$/i.test(b.textContent ?? ""))).toBe(false);
  await act(async () => buttons[0]!.click());
  expect(decide).toHaveBeenCalledWith(true);
});

test("a payment card turns only the confirm text to danger and lists the fields", () => {
  const pay: Card = { ...card, kind: "payment", body: undefined, confirm: "Pay $42.18", danger: true, fields: [{ label: "Card", value: "••••" }] };
  const el = mount(<ApprovalCard card={pay} onDecide={() => {}} />);
  expect(el.querySelector(".btn.primary.danger")!.textContent).toBe("Pay $42.18");
  expect(el.querySelector("dt")!.textContent).toBe("Card");
  expect(el.querySelector("dd")!.textContent).toBe("••••");
  expect(el.querySelector(".meta")!.textContent).toContain("always asks");
});

test("the perch dot breathes only while running, is still while waiting, and is gone when idle", () => {
  expect(mount(<PerchDot status="running" />).querySelector(".dot.live")).not.toBeNull();
  render(null, root);
  root.remove();
  const waiting = mount(<PerchDot status="waiting" />).querySelector(".dot")!;
  expect(waiting.classList.contains("live")).toBe(false);
  render(null, root);
  root.remove();
  expect(mount(<PerchDot status="idle" />).querySelector(".dot")).toBeNull();
});

test("steps collapse into one line and open on click", () => {
  const el = mount(<Steps steps={["Opened mail.example", "Read the thread", 'Clicked button "Send"']} />);
  expect(el.querySelector(".steps")!.textContent).toBe('3 steps · Clicked button "Send"');
  expect(el.querySelector(".steplist")).toBeNull();
  click(el.querySelector(".steps"));
  expect(el.querySelectorAll(".steplist li")).toHaveLength(3);
});

const reply: ChatMessage = { id: "a1", role: "assistant", text: "Done.\n[[artifact:x1]]", time: "2026-11-05T09:12:00Z", steps: ["Opened x"] };

test("a reply can be copied without artifact markers and branched", async () => {
  const writes: string[] = [];
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async (t: string) => void writes.push(t) }, configurable: true });
  const branch = mock((_: ChatMessage) => {});
  const el = mount(<Message message={reply} artifact={() => null} onBranch={branch} />);
  await act(async () => (el.querySelector('[aria-label="Copy reply"]') as HTMLElement).click());
  expect(writes).toEqual(["Done.\n"]);
  click(el.querySelector('[aria-label="Branch from here"]'));
  expect(branch).toHaveBeenCalledWith(reply);
  expect(el.querySelector(".meta-row .mono")!.textContent).toMatch(/^\d{1,2}:\d{2}$/);
});

test("stopped and failed replies say so in words", () => {
  const el = mount(<Message message={{ ...reply, text: "", stopped: true }} artifact={() => null} />);
  expect(el.textContent).toContain("Stopped");
  render(null, root);
  root.remove();
  const failed = mount(<Message message={{ ...reply, text: "", error: "The model is not signed in" }} artifact={() => null} />);
  expect(failed.querySelector('[role="alert"]')!.textContent).toBe("The model is not signed in");
});

const models: ModelInfo[] = [
  { id: "gpt-6-astra", label: "GPT-6 Astra", provider: "ChatGPT", efforts: ["low", "medium", "high"] },
  { id: "opus", label: "Claude Opus 5.5", provider: "Claude Code", efforts: ["medium"] },
];
const settings: ChatSettings = { mode: "guard", model: "gpt-6-astra", effort: "high", scope: "current" };

function composer(over: Partial<Parameters<typeof Composer>[0]> = {}) {
  const calls = { send: [] as string[], draft: [] as string[], settings: [] as Partial<ChatSettings>[], stop: 0 };
  const el = mount(
    <Composer
      draft=""
      onDraft={(t) => calls.draft.push(t)}
      onSend={(t) => void calls.send.push(t)}
      onStop={() => calls.stop++}
      running={false}
      tab={{ id: "t1", windowId: "w1", title: "Inbox (3)", url: "https://mail.example/inbox" }}
      settings={settings}
      models={models}
      onSettings={(p) => calls.settings.push(p)}
      {...over}
    />,
  );
  return { el, calls };
}

test("the composer shows the tab chip, the placeholder and real pickers", () => {
  const { el } = composer();
  expect(el.querySelector(".chip")!.textContent).toContain("Inbox (3)");
  expect(el.querySelector(".chip .d")!.textContent).toBe("mail.example");
  expect(el.querySelector("textarea")!.getAttribute("placeholder")).toBe(PLACEHOLDER);
  const pills = [...el.querySelectorAll(".crow .pill")].map((p) => p.textContent);
  expect(pills).toEqual(["Guard", "GPT-6 Astra", "High"]);
});

test("Enter sends, Shift+Enter does not, and typing reports the draft", () => {
  const { el, calls } = composer({ draft: "Find flights" });
  const field = el.querySelector("textarea")!;
  act(() => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })));
  expect(calls.send).toEqual([]);
  act(() => void field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(calls.send).toEqual(["Find flights"]);
  field.value = "Find flights to Tokyo";
  act(() => void field.dispatchEvent(new Event("input", { bubbles: true })));
  expect(calls.draft.at(-1)).toBe("Find flights to Tokyo");
});

test("while a task runs the send button becomes Stop", () => {
  const { el, calls } = composer({ running: true, draft: "more" });
  expect(el.querySelector('[aria-label="Send message"]')).toBeNull();
  click(el.querySelector('[aria-label="Stop task"]'));
  expect(calls.stop).toBe(1);
});

test("mode, effort and model pickers change the chat's settings", () => {
  const { el, calls } = composer();
  click(el.querySelector('[aria-label="Permission mode"]'));
  const options = [...el.querySelectorAll('[role="option"]')];
  expect(options.map((o) => o.querySelector(".opt-label")!.textContent)).toEqual(["Ask", "Guard", "Skip confirmation"]);
  click(options[2]!);
  expect(calls.settings.at(-1)).toEqual({ mode: "skip" });
  expect(el.querySelector('[aria-label="Tabs the agent may use"]')).toBeNull();
  click(el.querySelector('[aria-label="Effort"]'));
  click([...el.querySelectorAll('[role="option"]')].find((o) => o.textContent!.startsWith("Medium"))!);
  expect(calls.settings.at(-1)).toEqual({ effort: "medium" });
  click(el.querySelector('[aria-label="Model"]'));
  // The picker opens on the providers; a provider opens its models.
  expect([...el.querySelectorAll(".mm [role='option']")].map((o) => o.textContent)).toEqual(["ChatGPT", "Claude Code"]);
  click([...el.querySelectorAll(".mm [role='option']")].find((o) => o.textContent === "Claude Code")!);
  click([...el.querySelectorAll('[role="option"]')].find((o) => o.textContent!.startsWith("Claude Opus 5.5"))!);
  // Opus has no "high" effort here, so the effort falls back to one it has.
  expect(calls.settings.at(-1)).toEqual({ model: "opus", effort: "medium" });
});

test("the model picker searches across providers and works from the keyboard", () => {
  const { el, calls } = composer();
  click(el.querySelector('[aria-label="Model"]'));
  const search = el.querySelector<HTMLInputElement>(".mm input")!;
  expect(document.activeElement).toBe(search);
  search.value = "opus";
  act(() => void search.dispatchEvent(new Event("input", { bubbles: true })));
  expect([...el.querySelectorAll(".mm [role='option'] .opt-label")].map((o) => o.textContent)).toEqual(["Claude Opus 5.5"]);
  act(() => void search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(calls.settings.at(-1)).toEqual({ model: "opus", effort: "medium" });
  expect(el.querySelector(".mm")).toBeNull();
  click(el.querySelector('[aria-label="Model"]'));
  const key = (k: string) => act(() => void el.querySelector(".mm input")!.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));
  key("ArrowDown");
  key("ArrowRight");
  expect(el.querySelector(".mm-head")!.textContent).toBe("Claude Code");
  key("Escape");
  expect(el.querySelector(".mm-head")).toBeNull();
  key("Escape");
  expect(el.querySelector(".mm")).toBeNull();
});

test("efforts follow the model: the picker lists the model's own, and a switch keeps the nearest", () => {
  const { el } = composer({ models: [{ id: "a", label: "GPT-6 Astra", provider: "Codex", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] }], settings: { ...settings, model: "a" } });
  click(el.querySelector('[aria-label="Effort"]'));
  expect([...el.querySelectorAll('[role="option"] .opt-label')].map((o) => o.textContent)).toEqual(["Low", "Medium", "High", "Extra high", "Max", "Ultra"]);
  expect(fitEffort(["low", "medium", "high", "xhigh", "max"], "ultra")).toBe("max");
  expect(fitEffort(["medium"], "low")).toBe("medium");
  expect(matchModels(models, "claude code").map((m) => m.id)).toEqual(["opus"]);
});

test("the picker menu works from the keyboard and closes on Escape", () => {
  const { el, calls } = composer();
  click(el.querySelector('[aria-label="Permission mode"]'));
  const list = el.querySelector('[role="listbox"]')!;
  act(() => void list.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
  act(() => void list.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(calls.settings.at(-1)).toEqual({ mode: "ask" });
  click(el.querySelector('[aria-label="Permission mode"]'));
  act(() => void el.querySelector('[role="listbox"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(el.querySelector('[role="listbox"]')).toBeNull();
});

test("attach and dictate are visible but say why they are off", () => {
  const { el } = composer();
  const attach = el.querySelector('[aria-label="Attach files"]') as HTMLButtonElement;
  expect(attach.disabled).toBe(true);
  expect(attach.title).toContain("Perch build");
});

test("the chat list puts pinned chats first, marks unread, failed, selected and running chats, and filters", () => {
  const now = new Date("2026-11-05T12:00:00").getTime();
  const chats = [
    { id: "a", title: "Subscriptions from receipts", updatedAt: new Date("2026-11-05T09:00:00").toISOString(), tab: null, status: "running" as const, preview: "" },
    { id: "b", title: "Compare SFO to HND fares", updatedAt: new Date("2026-11-03T09:00:00").toISOString(), tab: null, status: "idle" as const, preview: "Cheapest is ANA", unread: true as const },
    { id: "c", title: "Old", updatedAt: new Date("2026-10-01T09:00:00").toISOString(), tab: null, status: "waiting" as const, preview: "", pinned: true as const },
    { id: "d", title: "Broken", updatedAt: new Date("2026-10-02T09:00:00").toISOString(), tab: null, status: "idle" as const, preview: "", failed: true as const },
  ];
  const picked: string[] = [];
  let settings = 0;
  const el = mount(<ChatList chats={chats} selected="a" now={now} onSelect={(id) => picked.push(id)} onNew={() => {}} onSettings={() => settings++} />);
  expect([...el.querySelectorAll(".lbl")].map((l) => l.textContent)).toEqual(["Chats"]);
  const rows = () => [...el.querySelectorAll(".row:not(.act)")];
  expect(rows().map((r) => r.querySelector(".row-t")!.textContent)).toEqual(["Old", "Subscriptions from receipts", "Compare SFO to HND fares", "Broken"]);
  expect(rows()[0]!.getAttribute("aria-label")).toBe("Old, Pinned, Needs your approval");
  expect(el.querySelector(".row.sel")!.textContent).toContain("Subscriptions from receipts");
  expect(el.querySelector(".row.sel .dot.live")).not.toBeNull();
  expect(rows()[2]!.querySelector(".mark.new")).not.toBeNull();
  expect(rows()[3]!.querySelector(".mark.err")).not.toBeNull();
  click([...el.querySelectorAll(".row.act")].find((r) => r.textContent!.includes("Settings"))!);
  expect(settings).toBe(1);
  click(rows().find((r) => r.textContent!.includes("Compare"))!);
  expect(picked).toEqual(["b"]);
  const search = el.querySelector('input[type="search"]') as HTMLInputElement;
  act(() => {
    search.value = "ana";
    search.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(rows().map((r) => r.querySelector(".row-t")!.textContent)).toEqual(["Compare SFO to HND fares"]);
});

test("chat times read as Aside's do", () => {
  const now = new Date("2026-11-05T12:00:00Z").getTime();
  expect(ago("2026-11-05T11:59:30Z", now)).toBe("just now");
  expect(ago("2026-11-05T11:55:00Z", now)).toBe("5 minutes ago");
  expect(ago("2026-11-05T09:00:00Z", now)).toBe("3 hours ago");
  expect(ago("2026-11-04T11:00:00Z", now)).toBe("1 day ago");
});

test("the artifact pane keeps its width in range and reads CSV", () => {
  expect(clampWidth(100)).toBe(PANE.min);
  expect(clampWidth(5000)).toBe(PANE.max);
  expect(clampWidth(400.4)).toBe(400);
  expect(parseCsv('name,cost\n"Music, family",10.99\n"Say ""hi""",1\n')).toEqual([["name", "cost"], ["Music, family", "10.99"], ['Say "hi"', "1"]]);
});

test("system theme follows macOS appearance and Increase Contrast", () => {
  const media = (dark: boolean, contrast: boolean) => (q: string) => ({ matches: q.includes("contrast") ? contrast : dark });
  expect(resolveTheme("system", media(true, false))).toBe("ink");
  expect(resolveTheme("system", media(false, false))).toBe("paper");
  expect(resolveTheme("system", media(false, true))).toBe("contrast");
  expect(resolveTheme("dusk", media(false, true))).toBe("dusk");
});

test("a working run shows its clock, what the agent said and its steps with the current one marked; approval hides the clock", () => {
  const working = mount(<LiveRun text="Looking for chinos." steps={["Open shop.example", "Read the page"]} waiting={false} since={new Date(Date.now() - 65_000).toISOString()} />);
  expect(working.querySelector(".work")?.textContent).toBe("Working for 1m 5s");
  expect(working.textContent).toContain("Looking for chinos.");
  expect([...working.querySelectorAll(".steplist.now li")].map((li) => li.textContent)).toEqual(["Open shop.example", "Read the page"]);
  expect(working.querySelector(".steplist.now li.current")?.textContent).toBe("Read the page");
  render(null, root);
  root.remove();
  const waiting = mount(<LiveRun text="" steps={["a", "b", "c", "d", "e", "f", "g", "h"]} waiting />);
  expect(waiting.querySelector(".work")).toBeNull();
  expect(waiting.querySelector(".steps")?.textContent).toContain("2 steps · b");
  expect(waiting.querySelectorAll(".steplist.now li").length).toBe(6);
  expect(waiting.querySelector("li.current")).toBeNull();
});

test("the model picker draws each provider's own mark, and none for providers without one", () => {
  expect(providerPath("Claude Code")).not.toBeNull();
  expect(providerPath("Claude Code")).not.toBe(providerPath("Anthropic API key"));
  expect(providerPath("Codex")).toBe(providerPath("ChatGPT"));
  expect(providerPath("Grok")).toBe(providerPath("xAI API key"));
  expect(providerPath("Perch")).toBeNull();
  expect(providerPath("Ollama")).toBeNull();
});

test("a memoized component renders again only when a prop changes", () => {
  let renders = 0;
  const Counted = memo(({ text }: { text: string; other?: number }) => {
    renders++;
    return <p>{text}</p>;
  });
  const el = mount(<Counted text="a" other={1} />);
  act(() => render(<Counted text="a" other={1} />, root));
  expect(renders).toBe(1);
  act(() => render(<Counted text="b" other={1} />, root));
  expect(renders).toBe(2);
  expect(el.textContent).toBe("b");
});

test("copying a reply that the clipboard refuses does not claim it was copied", async () => {
  const clipboard = navigator.clipboard;
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
  try {
    const el = mount(<Message message={reply} artifact={() => null} />);
    await act(async () => (el.querySelector('[aria-label="Copy reply"]') as HTMLElement).click());
    expect(el.querySelector('[aria-label="Copied"]')).toBeNull();
  } finally {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard });
  }
});
