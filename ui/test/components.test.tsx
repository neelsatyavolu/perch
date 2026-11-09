import { afterEach, expect, mock, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { ApprovalCard as Card, ChatMessage, ChatSettings, ModelInfo } from "../src/api/types";
import { ApprovalCard } from "../src/components/approval";
import { clampWidth, parseCsv, PANE } from "../src/components/artifact-pane";
import { ChatList } from "../src/components/chat-list";
import { Composer, PLACEHOLDER } from "../src/components/composer";
import { PerchDot } from "../src/components/icon";
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
      onSend={(t) => calls.send.push(t)}
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
  const pills = [...el.querySelectorAll(".under .pill")].map((p) => p.textContent);
  expect(pills).toEqual(["Guard", "Current tab", "GPT-6 Astra · high"]);
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

test("mode, scope and model pickers change the chat's settings", () => {
  const { el, calls } = composer();
  click(el.querySelector('[aria-label="Permission mode"]'));
  const options = [...el.querySelectorAll('[role="option"]')];
  expect(options.map((o) => o.querySelector(".opt-label")!.textContent)).toEqual(["Ask", "Guard", "Skip confirmation"]);
  click(options[2]!);
  expect(calls.settings.at(-1)).toEqual({ mode: "skip" });
  click(el.querySelector('[aria-label="Tabs the agent may use"]'));
  click([...el.querySelectorAll('[role="option"]')].find((o) => o.textContent!.startsWith("New agent tabs"))!);
  expect(calls.settings.at(-1)).toEqual({ scope: "agent" });
  click(el.querySelector('[aria-label="Model and effort"]'));
  click([...el.querySelectorAll('[role="option"]')].find((o) => o.textContent!.startsWith("Claude Opus 5.5"))!);
  // Opus has no "high" effort here, so the effort falls back to one it has.
  expect(calls.settings.at(-1)).toEqual({ model: "opus", effort: "medium" });
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

test("the chat list groups by day and marks the selected and running chats", () => {
  const now = new Date("2026-11-05T12:00:00").getTime();
  const chats = [
    { id: "a", title: "Subscriptions from receipts", updatedAt: new Date("2026-11-05T09:00:00").toISOString(), tab: null, status: "running" as const, preview: "" },
    { id: "b", title: "Compare SFO to HND fares", updatedAt: new Date("2026-11-03T09:00:00").toISOString(), tab: null, status: "idle" as const, preview: "" },
    { id: "c", title: "Old", updatedAt: new Date("2026-10-01T09:00:00").toISOString(), tab: null, status: "waiting" as const, preview: "" },
  ];
  const picked: string[] = [];
  const el = mount(<ChatList chats={chats} selected="a" now={now} onSelect={(id) => picked.push(id)} onNew={() => {}} />);
  expect([...el.querySelectorAll(".lbl")].map((l) => l.textContent)).toEqual(["Today", "This week", "Earlier"]);
  expect(el.querySelector(".row.sel")!.textContent).toContain("Subscriptions from receipts");
  expect(el.querySelector(".row.sel .dot.live")).not.toBeNull();
  expect(el.textContent).toContain("Needs your approval");
  click([...el.querySelectorAll(".row")].find((r) => r.textContent!.includes("Compare"))!);
  expect(picked).toEqual(["b"]);
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

test("a run waiting for approval still counts its last step; a working run shows it on the live line", () => {
  const waiting = mount(<LiveRun text="" steps={["Read the message", "Checked the calendar"]} waiting />);
  expect(waiting.querySelector(".steps")?.textContent).toContain("2 steps · Checked the calendar");
  expect(waiting.querySelector(".work")).toBeNull();
  render(null, root);
  root.remove();
  const working = mount(<LiveRun text="" steps={["Read the message", "Checked the calendar"]} waiting={false} />);
  expect(working.querySelector(".steps")?.textContent).toContain("1 step · Read the message");
  expect(working.querySelector(".work")?.textContent).toContain("Checked the calendar");
});

test("the model picker draws each provider's own mark, and none for providers without one", () => {
  expect(providerPath("Claude Code")).not.toBeNull();
  expect(providerPath("Claude Code")).not.toBe(providerPath("Anthropic API key"));
  expect(providerPath("Codex")).toBe(providerPath("ChatGPT"));
  expect(providerPath("Grok")).toBe(providerPath("xAI API key"));
  expect(providerPath("Perch")).toBeNull();
  expect(providerPath("Ollama")).toBeNull();
});
