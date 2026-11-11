import { expect, test } from "bun:test";
import { applyToView, type ChatView } from "../src/state/chat";

test("a rename reaches the open chat's header, and only that chat's", () => {
  const view = { chat: { id: "c1", title: "New chat", messages: [] }, run: null, artifacts: [] } as unknown as ChatView;
  const summary = (id: string, title: string) => ({ type: "chat.updated", chat: { id, title, updatedAt: "2026-11-10T00:00:00Z", tab: null, status: "idle", preview: "" } }) as never;
  expect(applyToView(view, summary("c1", "Find cheap chinos")).chat!.title).toBe("Find cheap chinos");
  expect(applyToView(view, summary("c2", "Other"))).toBe(view);
});
