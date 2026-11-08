import { expect, test } from "bun:test";
import { createFrameHost } from "../src/host/frame-host";
import { HOST_EVENT, HOST_REPLY, HOST_REQUEST, openableUrl } from "../src/host/protocol";
import { createRelay } from "../src/host/shell";
import { applyMention, keptMentions, matchTabs, mentionQuery } from "../src/components/mentions";

const FRAME = "chrome-untrusted://perch-side-chat.top-chrome";

function relay() {
  const sent: { message: string; args: unknown[] }[] = [];
  const posted: unknown[] = [];
  const frame = {};
  const r = createRelay({ send: (message, args) => sent.push({ message, args }), frameOrigin: FRAME, isFrame: (s) => s === frame, post: (m) => posted.push(m) });
  return { r, sent, posted, frame };
}

test("the shell relays known calls from its own frame and answers by the frame's id", () => {
  const { r, sent, posted, frame } = relay();
  r.onMessage(frame, FRAME, { type: HOST_REQUEST, id: "h1", method: "chooseFiles", args: [] });
  expect(sent).toEqual([{ message: "perchHost", args: ["shell-1", "chooseFiles", []] }]);
  r.onResponse("shell-1", true, [{ id: "f1", name: "a.pdf", size: 3 }]);
  expect(posted).toEqual([{ type: HOST_REPLY, id: "h1", ok: true, result: [{ id: "f1", name: "a.pdf", size: 3 }] }]);
  // A second answer to the same call goes nowhere.
  r.onResponse("shell-1", true, []);
  expect(posted.length).toBe(1);
});

test("the shell drops other windows, other origins and unknown calls, and opens web pages only", () => {
  const { r, sent, posted, frame } = relay();
  r.onMessage({}, FRAME, { type: HOST_REQUEST, id: "h1", method: "close" });
  r.onMessage(frame, "https://evil.test", { type: HOST_REQUEST, id: "h2", method: "close" });
  expect(sent).toEqual([]);
  r.onMessage(frame, FRAME, { type: HOST_REQUEST, id: "h3", method: "send", args: ["perch.call"] });
  r.onMessage(frame, FRAME, { type: HOST_REQUEST, id: "h4", method: "openTab", args: ["chrome://settings"] });
  r.onMessage(frame, FRAME, { type: HOST_REQUEST, id: "h5", method: "openTab", args: ["file:///etc/passwd"] });
  expect(sent).toEqual([]);
  expect(posted.map((p) => (p as { ok: boolean }).ok)).toEqual([false, false, false]);
  r.onMessage(frame, FRAME, { type: HOST_REQUEST, id: "h6", method: "openTab", args: ["https://example.test/"] });
  expect(sent).toEqual([{ message: "perchHost", args: ["shell-1", "openTab", ["https://example.test/"]] }]);
  expect(openableUrl("perch-artifact://abc/1")).toBe("perch-artifact://abc/1");
  expect(openableUrl("javascript:alert(1)")).toBeNull();
});

test("a refusal from the browser reaches the frame as its message, and dictation text is forwarded", () => {
  const { r, posted, frame } = relay();
  r.onMessage(frame, FRAME, { type: HOST_REQUEST, id: "h1", method: "startDictation" });
  r.onResponse("shell-1", false, { code: "denied", message: "Allow speech recognition for Perch in System Settings" });
  r.onEvent("perch-dictation", { text: "book a", final: false });
  r.onEvent("something-else", {});
  expect(posted).toEqual([
    { type: HOST_REPLY, id: "h1", ok: false, error: "Allow speech recognition for Perch in System Settings" },
    { type: HOST_EVENT, event: "dictation", data: { text: "book a", final: false } },
  ]);
});

/** A frame window whose parent is a fake shell; returns what the frame posted and a way to answer. */
function framed(ancestor: string) {
  const posted: { msg: { id: string; method: string; args: unknown[] }; origin: string }[] = [];
  const listeners: ((e: MessageEvent) => void)[] = [];
  const parent = { postMessage: (msg: never, origin: string) => posted.push({ msg, origin }) };
  const win = {
    parent,
    location: { ancestorOrigins: [ancestor] },
    addEventListener: (_: string, l: (e: MessageEvent) => void) => listeners.push(l),
  } as unknown as Parameters<typeof createFrameHost>[0];
  const deliver = (data: unknown, source: unknown = parent, origin = ancestor) => listeners.forEach((l) => l({ data, source, origin } as MessageEvent));
  return { win, posted, deliver, parent };
}

test("the frame host talks only to a Perch shell, matches replies by id, and ignores strangers", async () => {
  expect(createFrameHost(framed("https://evil.test").win)).toBeUndefined();
  const { win, posted, deliver } = framed("chrome://perch-side-chat.top-chrome");
  const host = createFrameHost(win)!;
  const files = host.chooseFiles!();
  expect(posted[0]).toEqual({ msg: { type: HOST_REQUEST, id: "h1", method: "chooseFiles", args: [] } as never, origin: "chrome://perch-side-chat.top-chrome" });
  deliver({ type: HOST_REPLY, id: "h1", ok: true, result: [{ id: "x", name: "fake", size: 1 }] }, {}, "chrome://perch-side-chat.top-chrome");
  deliver({ type: HOST_REPLY, id: "h1", ok: true, result: [{ id: "f1", name: "a.pdf", size: 3 }, { path: "/etc" }] });
  expect(await files).toEqual([{ id: "f1", name: "a.pdf", size: 3 }]);

  const heard: [string, boolean][] = [];
  const started = host.startDictation!((text, final) => heard.push([text, final]));
  deliver({ type: HOST_REPLY, id: "h2", ok: true });
  await started;
  deliver({ type: HOST_EVENT, event: "dictation", data: { text: "find", final: false } });
  deliver({ type: HOST_EVENT, event: "dictation", data: { text: "find flights", final: true } });
  deliver({ type: HOST_EVENT, event: "dictation", data: { text: "late", final: false } });
  expect(heard).toEqual([["find", false], ["find flights", true]]);
});

test("@ names a tab at the end of the draft and keeps only mentions still in the text", () => {
  const tabs = [
    { id: "a", windowId: "w", title: "Flights to Tokyo", url: "https://flights.example/" },
    { id: "b", windowId: "w", title: "Inbox", url: "https://mail.example/" },
  ];
  expect(mentionQuery("compare with @fli")).toBe("fli");
  expect(mentionQuery("email me@example.com")).toBeNull();
  expect(matchTabs(tabs, "mail").map((t) => t.id)).toEqual(["b"]);
  const draft = applyMention("compare with @fli", tabs[0]!);
  expect(draft).toBe("compare with @Flights to Tokyo ");
  expect(keptMentions(draft, tabs)).toEqual([tabs[0]!]);
});
