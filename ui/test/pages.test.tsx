import { afterEach, beforeEach, expect, test } from "bun:test";
import { render } from "preact";
import { act } from "preact/test-utils";
import type { ArtifactMeta } from "../src/api/types";
import { ArtifactPane } from "../src/components/artifact-pane";
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

test("the side chat's own header is the panel header: history, new chat and close, which asks the browser to close the panel", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  let closed = 0;
  const el = await mount(<Sidebar client={client} windowId="w1" host={{ close: () => void closed++ }} />);
  const header = el.querySelectorAll("header");
  expect(header.length).toBe(1);
  expect(header[0]!.querySelector("h1.title")!.textContent).toBe("New chat");
  expect(header[0]!.querySelector('[aria-label="Recent chats"]')).not.toBeNull();
  expect(header[0]!.querySelector('[aria-label="New chat"]')).not.toBeNull();
  await act(async () => (header[0]!.querySelector('[aria-label="Close side chat"]') as HTMLElement).click());
  expect(closed).toBe(1);
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
  expect(el.querySelector(".work")!.textContent).toBe("Working for 0s");
  expect(el.querySelector(".steplist.now li.current")!.textContent).toBe("Opened mail.example");
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

test("a draft typed in a tab with no side chat yet comes back when the user returns to that tab", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  await typeInto(el.querySelector("textarea")!, "Ask about the invoice");
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabB, chatId: null } }));
  await settle();
  expect(el.querySelector("textarea")!.value).toBe("");
  await typeInto(el.querySelector("textarea")!, "Something for docs");
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabA, chatId: null } }));
  await settle();
  expect(el.querySelector("textarea")!.value).toBe("Ask about the invoice");
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabB, chatId: null } }));
  await settle();
  expect(el.querySelector("textarea")!.value).toBe("Something for docs");
});

test("a navigation in the active tab updates the tab the sidebar sends as context", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  await typeInto(el.querySelector("textarea")!, "Keep this draft");
  const moved = { ...tabA, title: "Re: Lunch", url: "https://mail.example/m/1" };
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: moved, chatId: null } }));
  await settle();
  expect(el.querySelector(".chip-t")!.textContent).toBe("Re: Lunch");
  expect(el.querySelector("textarea")!.value).toBe("Keep this draft");
  // The browser said the tab has no side chat, so there was nothing to fetch, then or after.
  expect(client.calls.filter((c) => c.name === "tabChat")).toHaveLength(0);
  await act(async () => (el.querySelector('[aria-label="Send message"]') as HTMLElement).click());
  await settle();
  expect(client.calls.find((c) => c.name === "send")!.args[2]).toEqual(moved);
});

const imageMeta: ArtifactMeta = { id: "img1", chatId: "c1", title: "Chart", kind: "image", version: 1, versions: 1, updatedAt: "", url: "http://127.0.0.1:9/a/img1/1?k=x" };

test("saving an image artifact downloads its bytes through the API, never navigating to the artifact origin", async () => {
  const client = fakeClient();
  client.artifact = (async () => ({ meta: imageMeta, content: null })) as typeof client.artifact;
  const clicked: string[] = [];
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push(this.href);
  };
  try {
    const el = await mount(<ArtifactPane client={client} meta={imageMeta} width={360} onWidth={() => {}} onClose={() => {}} />);
    await act(async () => (el.querySelector('[aria-label="Save to disk"]') as HTMLElement).click());
    await settle();
    expect(client.calls.find((c) => c.name === "artifactFile")!.args).toEqual(["img1", 1]);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.startsWith("blob:")).toBe(true);
  } finally {
    HTMLAnchorElement.prototype.click = original;
  }
});

test("pages and drawings render in a frame that may run scripts but not open popups", async () => {
  const client = fakeClient();
  const page = { ...imageMeta, id: "p1", kind: "html" as const, title: "Page" };
  client.artifact = (async () => ({ meta: page, content: "<p>hi</p>" })) as typeof client.artifact;
  const el = await mount(<ArtifactPane client={client} meta={page} width={360} onWidth={() => {}} onClose={() => {}} />);
  expect(el.querySelector("iframe")!.getAttribute("sandbox")).toBe("allow-scripts");
});

test("until the tab's chat is known the sidebar shows no empty state and no title", async () => {
  const client = fakeClient();
  client.windowState = () => new Promise(() => {});
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  expect(el.querySelector(".empty")).toBeNull();
  expect(el.querySelector(".side-h .title")!.textContent).toBe("");
});

test("a new tab with no side chat switches chip, header and thread in one step, with no fetch", async () => {
  const client = fakeClient();
  const side = await client.openSideChat("tA", "w1");
  client.chatsById.set(side.id, { ...side, title: "Inbox help" });
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: side.id });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  const fetched = client.calls.filter((c) => c.name === "tabChat").length;
  // No settle: whatever shows right after the event is what the user sees first.
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabB, chatId: null } }));
  expect(el.querySelector(".chip-t")!.textContent).toBe("Docs");
  expect(el.querySelector(".side-h .title")!.textContent).toBe("New chat");
  expect(el.querySelector(".empty")).not.toBeNull();
  expect(client.calls.filter((c) => c.name === "tabChat")).toHaveLength(fetched);
});

test("a tab with a side chat keeps the old chip until its chat arrives, then changes everything together", async () => {
  const client = fakeClient();
  const side = await client.openSideChat("tB", "w1");
  client.chatsById.set(side.id, { ...side, title: "Docs help" });
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  let release = () => {};
  const tabChat = client.tabChat;
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  client.tabChat = (id) => new Promise((done) => (release = () => done(tabChat(id))));
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabB, chatId: side.id } }));
  expect(el.querySelector(".chip-t")!.textContent).toBe("Mailroom");
  expect(el.querySelector(".side-h .title")!.textContent).toBe("New chat");
  release();
  await settle();
  expect(el.querySelector(".chip-t")!.textContent).toBe("Docs");
  expect(el.querySelector(".side-h .title")!.textContent).toBe("Docs help");
});

test("a side chat deleted elsewhere leaves the sidebar, keeping what was typed", async () => {
  const client = fakeClient();
  const side = await client.openSideChat("tA", "w1");
  client.chatsById.set(side.id, { ...side, title: "Inbox help" });
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: side.id });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  await typeInto(el.querySelector("textarea")!, "not sent yet");
  await act(async () => client.emit({ type: "chat.removed", chatId: side.id }));
  await settle();
  expect(el.querySelector(".side-h .title")!.textContent).toBe("New chat");
  expect(el.querySelector("textarea")!.value).toBe("not sent yet");
  expect(client.calls.some((c) => c.name === "patchChat" && c.args[0] === side.id)).toBe(false);
});

test("after the event stream reconnects the sidebar reloads its chat, so a finished run stops showing Working", async () => {
  const client = fakeClient();
  const side = await client.openSideChat("tA", "w1");
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: side.id });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  const message = { id: "u1", role: "user" as const, text: "Reply to Maya", time: new Date().toISOString() };
  await act(async () => client.emit({ type: "run.started", chatId: side.id, runId: "r1", message }));
  expect(el.querySelector(".side-h .state")!.textContent).toBe("Working");
  await act(async () => client.status(false));
  client.chatsById.set(side.id, { ...client.chatsById.get(side.id)!, messages: [message, { id: "a1", role: "assistant", text: "Sent.", time: new Date().toISOString() }] });
  await act(async () => client.status(true));
  await settle();
  expect(el.querySelector(".side-h .state")).toBeNull();
  expect(el.querySelector(".reply .md")!.textContent).toBe("Sent.");
});

test("a send that fails puts the text back and says why", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  client.send = () => Promise.reject(new Error("Perch did not answer (503). Try again in a moment"));
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  await typeInto(el.querySelector("textarea")!, "Summarise this inbox");
  await act(async () => (el.querySelector('[aria-label="Send message"]') as HTMLElement).click());
  await settle();
  expect(el.querySelector("textarea")!.value).toBe("Summarise this inbox");
  expect(el.querySelector(".note.error")!.textContent).toContain("503");
});

test("files attached in one tab do not carry over to the next tab's chat", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  const el = await mount(<Sidebar client={client} windowId="w1" host={{ chooseFiles: async () => [{ id: "f1", name: "itinerary.pdf", size: 2048 }] }} />);
  await act(async () => (el.querySelector('[aria-label="Attach files"]') as HTMLElement).click());
  await settle();
  expect(el.querySelector(".chip.file")).not.toBeNull();
  await act(async () => client.emit({ type: "window.active", state: { windowId: "w1", tab: tabB, chatId: null } }));
  await settle();
  expect(el.querySelector(".chip.file")).toBeNull();
});

test("the recent chats menu says when there are none, and Escape puts focus back on its button", async () => {
  const client = fakeClient();
  client.windows.set("w1", { windowId: "w1", tab: tabA, chatId: null });
  const el = await mount(<Sidebar client={client} windowId="w1" />);
  const button = el.querySelector('[aria-label="Recent chats"]') as HTMLElement;
  await act(async () => button.click());
  const list = el.querySelector(".menu") as HTMLElement;
  expect(list.textContent).toBe("No other chats yet");
  await act(async () => void list.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(el.querySelector(".menu")).toBeNull();
  expect(document.activeElement).toBe(button);
});

test("in the full-page chat a slow load never replaces a chat opened after it", async () => {
  const client = fakeClient();
  const slow = await client.createChat();
  const fast = await client.createChat();
  client.chatsById.set(slow.id, { ...slow, title: "Slow one" });
  client.chatsById.set(fast.id, { ...fast, title: "Fast one" });
  const load = client.chat;
  client.chat = (id) => (id === slow.id ? Bun.sleep(20).then(() => load(id)) : load(id));
  const navigated: (string | null)[] = [];
  const el = await mount(<FullChat client={client} onNavigate={(id) => navigated.push(id)} />);
  const row = (title: string) => [...el.querySelectorAll(".chats .row")].find((r) => r.textContent!.includes(title)) as HTMLElement;
  await act(async () => row("Slow one").click());
  await act(async () => row("Fast one").click());
  await act(async () => void (await Bun.sleep(40)));
  expect(el.querySelector(".fc-h .title")!.textContent).toBe("Fast one");
  expect(navigated).toEqual([fast.id]);
});

test("a failed delete in the full-page chat says so instead of failing silently", async () => {
  const client = fakeClient();
  const chat = await client.createChat();
  client.deleteChat = () => Promise.reject(new Error("Perch did not answer (500). Try again in a moment"));
  const el = await mount(<FullChat client={client} initialChat={chat.id} />);
  await act(async () => (el.querySelector('[aria-label="More"]') as HTMLElement).click());
  await act(async () => ([...el.querySelectorAll('[role="option"]')].find((o) => o.textContent!.includes("Delete chat")) as HTMLElement).click());
  await act(async () => (el.querySelector(".confirm .danger-text") as HTMLElement).click());
  await settle();
  expect(el.querySelector(".note.error")!.textContent).toContain("500");
});
