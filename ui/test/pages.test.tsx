import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import { FullChat } from "../src/pages/full-chat";
import { Sidebar } from "../src/pages/sidebar";
import { fakeClient } from "./fake-client";

const setWidth = (width: number) => (window as unknown as { happyDOM: { setWindowSize(s: { width: number; height: number }): void } }).happyDOM.setWindowSize({ width, height: 900 });

let root: HTMLElement;
beforeEach(() => setWidth(1440));
afterEach(() => {
  act(() => render(null, root));
  root.remove();
});
async function mount(node: preact.VNode): Promise<HTMLElement> {
  root = document.createElement("div");
  document.body.appendChild(root);
  await act(async () => render(node, root));
  await settle();
  return root;
}
const settle = () => act(async () => void (await Bun.sleep(5)));
const typeInto = async (el: HTMLTextAreaElement, text: string) => {
  el.value = text;
  await act(async () => void el.dispatchEvent(new Event("input", { bubbles: true })));
};
const tabA = { id: "tA", windowId: "w1", title: "Mailroom", url: "https://mail.example" };
const tabB = { id: "tB", windowId: "w1", title: "Docs", url: "https://docs.example" };

test("the sidebar's first message opens a side chat for the tab and sends with its context", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  expect(el.querySelector(".empty")!.textContent).toContain("Ask Perch");
  await typeInto(el.querySelector("textarea")!, "Summarise this inbox");
  await act(async () => (el.querySelector('[aria-label="Send message"]') as HTMLElement).click());
  await settle();
  const open = client.calls.find((c) => c.name === "openSideChat")!;
  expect(open.args.slice(0, 2)).toEqual(["tA", "w1"]);
  const send = client.calls.find((c) => c.name === "send")!;
  expect(send.args[1]).toBe("Summarise this inbox");
  expect(send.args[2]).toEqual(tabA);
});

test("switching tabs hides a side chat and switching back restores its draft", async () => {
  const client = fakeClient();
  const side = await client.openSideChat("tA", "w1");
  client.chatsById.set(side.id, { ...side, title: "Inbox help", draft: "half a thought", scrollTop: 0 });
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: side.id });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  expect(el.querySelector(".side-h .title")!.textContent).toBe("Inbox help");
  expect(el.querySelector("textarea")!.value).toBe("half a thought");
  await typeInto(el.querySelector("textarea")!, "half a thought, now longer");

  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabB, chatId: null } }));
  await settle();
  expect(el.querySelector(".side-h .title")!.textContent).toBe("New chat");
  expect(el.querySelector("textarea")!.value).toBe("");
  // The draft was saved before the switch, not lost.
  expect(client.calls.some((c) => c.name === "patchChat" && (c.args[1] as { draft?: string }).draft === "half a thought, now longer")).toBe(true);

  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabA, chatId: side.id } }));
  await settle();
  expect(el.querySelector(".side-h .title")!.textContent).toBe("Inbox help");
  expect(el.querySelector("textarea")!.value).toBe("half a thought, now longer");
});

test("another window's tab switch does not change this sidebar", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w2", tab: tabB, chatId: null } }));
  await settle();
  expect(el.querySelector(".chip-t")!.textContent).toBe("Mailroom");
});

test("a run streams into the sidebar, the approval card replaces the working line, and approving calls the API", async () => {
  const client = fakeClient();
  const side = await client.openSideChat("tA", "w1");
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: side.id });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  const message = { id: "u1", role: "user" as const, text: "Reply to Maya", time: new Date().toISOString() };
  await act(async () => client.emit({ type: "run.started", chatId: side.id, runId: "r1", message }));
  await act(async () => client.emit({ type: "run.step", chatId: side.id, runId: "r1", label: "Opened mail.example" }));
  expect(el.querySelector(".work")!.textContent).toBe("Opened mail.example");
  expect(el.querySelector(".side-h .dot.live")).not.toBeNull();
  expect(el.querySelector(".side-h .state")!.textContent).toBe("Working");
  expect(el.querySelector('[aria-label="Stop task"]')).not.toBeNull();
  await act(async () => client.emit({ type: "run.approval", chatId: side.id, runId: "r1", card: { id: "p1", chatId: side.id, runId: "r1", title: 'Click button "Send"', site: "mail.example", kind: "risky", confirm: "Send", danger: false } }));
  expect(el.querySelector(".work")).toBeNull();
  expect(el.querySelector(".side-h .dot.live")).toBeNull();
  expect(el.querySelector(".side-h .dot")).not.toBeNull();
  await act(async () => (el.querySelector(".approve .btn.primary") as HTMLElement).click());
  expect(client.calls.find((c) => c.name === "decide")!.args).toEqual(["p1", true]);
  await act(async () => client.emit({ type: "run.finished", chatId: side.id, runId: "r1", message: { id: "a1", role: "assistant", text: "Sent.", time: new Date().toISOString() } }));
  expect(el.querySelector(".reply .md")!.textContent).toBe("Sent.");
  expect(el.querySelector(".side-h .dot")).toBeNull();
});

test("the full-page chat creates a chat on first send, with the agent's own tabs", async () => {
  const client = fakeClient();
  const el = await mount(<FullChat client={client} />);
  expect(el.querySelector(".chats")).not.toBeNull();
  expect(el.querySelector(".fc-h .title")!.textContent).toBe("New chat");
  await typeInto(el.querySelector("textarea")!, "What am I paying for every month?");
  await act(async () => (el.querySelector('[aria-label="Send message"]') as HTMLElement).click());
  await settle();
  const created = client.calls.find((c) => c.name === "createChat")!;
  expect((created.args[0] as { settings: { scope: string } }).settings.scope).toBe("agent");
  expect(client.calls.find((c) => c.name === "send")!.args[1]).toBe("What am I paying for every month?");
});

test("the full-page chat lists chats, opens one, renames it and branches from a reply", async () => {
  const client = fakeClient();
  const chat = await client.createChat();
  client.chatsById.set(chat.id, { ...chat, title: "Subscriptions", messages: [{ id: "u1", role: "user", text: "q", time: "2026-11-05T09:00:00Z" }, { id: "a1", role: "assistant", text: "answer", time: "2026-11-05T09:01:00Z" }] });
  const navigated: (string | null)[] = [];
  const el = await mount(<FullChat client={client} onNavigate={(id) => navigated.push(id)} />);
  await act(async () => ([...el.querySelectorAll(".chats .row")].find((r) => r.textContent!.includes("Subscriptions")) as HTMLElement).click());
  await settle();
  expect(navigated.at(-1)).toBe(chat.id);
  expect(el.querySelector(".me")!.textContent).toBe("q");
  await act(async () => (el.querySelector(".fc-h .title") as HTMLElement).click());
  const input = el.querySelector(".title-edit") as HTMLInputElement;
  input.value = "Monthly subscriptions";
  await act(async () => void input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await settle();
  expect(client.calls.find((c) => c.name === "patchChat" && (c.args[1] as { title?: string }).title)!.args[1]).toEqual({ title: "Monthly subscriptions" });
  await act(async () => (el.querySelector('[aria-label="Branch from here"]') as HTMLElement).click());
  await settle();
  expect(client.calls.find((c) => c.name === "branch")!.args).toEqual([chat.id, "a1"]);
});

test("below 1100px the chat list starts collapsed and the toggle still opens it", async () => {
  setWidth(1024);
  const el = await mount(<FullChat client={fakeClient()} />);
  expect(el.querySelector(".chats")).toBeNull();
  await act(async () => (el.querySelector('[aria-label="Chat list"]') as HTMLElement).click());
  expect(el.querySelector(".chats")).not.toBeNull();
});

test("deleting a chat asks first, in words", async () => {
  const client = fakeClient();
  const chat = await client.createChat();
  const el = await mount(<FullChat client={client} initialChat={chat.id} />);
  await act(async () => (el.querySelector('[aria-label="More"]') as HTMLElement).click());
  await act(async () => ([...el.querySelectorAll('[role="option"]')].find((o) => o.textContent!.includes("Delete chat")) as HTMLElement).click());
  expect(el.querySelector(".confirm")!.textContent).toContain("cannot be undone");
  expect(client.calls.some((c) => c.name === "deleteChat")).toBe(false);
  await act(async () => (el.querySelector(".confirm .danger-text") as HTMLElement).click());
  await settle();
  expect(client.calls.some((c) => c.name === "deleteChat")).toBe(true);
});
