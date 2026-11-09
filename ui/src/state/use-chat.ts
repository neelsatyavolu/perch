/**
 * One open chat in a page: its view (kept current from app events), the unsent draft (saved
 * shortly after typing stops, and at once when the page switches chats), and the actions.
 */

import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { ChatPayload, Client } from "../api/client";
import type { AppEvent, ChatSettings, TabInfo } from "../api/types";
import type { SendExtras } from "../components/composer";
import { applyToView, emptyView, type ChatView } from "./chat";

const DRAFT_SAVE_MS = 400;

export function useChat(client: Client) {
  const [view, setView] = useState<ChatView>(emptyView);
  const [draft, setDraftState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const current = useRef<{ chatId: string | null; draft: string; saved: string; timer?: ReturnType<typeof setTimeout> }>({ chatId: null, draft: "", saved: "" });

  const saveDraft = useCallback(async () => {
    const c = current.current;
    clearTimeout(c.timer);
    if (!c.chatId || c.draft === c.saved) return;
    const text = c.draft;
    c.saved = text;
    await client.patchChat(c.chatId, { draft: text }).catch(() => undefined);
  }, [client]);

  /**
   * Shows a chat, or none with `draftIfNone` in the composer, at once. The previous chat's draft is
   * saved in the background: saveDraft reads it before its first await, so a later show never races it.
   */
  const show = useCallback(
    (payload: ChatPayload | null, draftIfNone = "") => {
      void saveDraft();
      const next = payload?.chat ? { chat: payload.chat, run: payload.run, artifacts: payload.artifacts } : emptyView;
      const draft = next.chat ? next.chat.draft : draftIfNone;
      current.current = { chatId: next.chat?.id ?? null, draft, saved: draft };
      setDraftState(draft);
      setError(null);
      setFrame(null);
      setView(next);
    },
    [saveDraft],
  );

  /** The chat shown now and its unsent draft, read at call time. */
  const unsent = useCallback(() => ({ chatId: current.current.chatId, draft: current.current.draft }), []);

  /** The live thumbnail of the open chat's running task. */
  const [frame, setFrame] = useState<string | null>(null);
  const onEvent = useCallback((event: AppEvent) => {
    if (event.type === "run.frame") {
      if (event.chatId === current.current.chatId) setFrame(event.data);
      return;
    }
    // The open chat was deleted elsewhere: show none, keep the unsent text, and save nothing to it.
    if (event.type === "chat.removed" && event.chatId === current.current.chatId) {
      const { draft, timer } = current.current;
      clearTimeout(timer);
      current.current = { chatId: null, draft, saved: draft };
      setFrame(null);
      setView(emptyView);
      return;
    }
    setView((v) => applyToView(v, event));
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      const c = current.current;
      c.draft = text;
      setDraftState(text);
      clearTimeout(c.timer);
      c.timer = setTimeout(() => void saveDraft(), DRAFT_SAVE_MS);
    },
    [saveDraft],
  );

  const guard = async (work: () => Promise<unknown>) => {
    try {
      setError(null);
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /**
   * Sends to the open chat, or to the chat `ensure` creates when none is open. Resolves true once
   * sent. On failure the text comes back, if that chat is still shown and nothing new was typed.
   */
  const send = async (text: string, context: TabInfo | undefined, ensure: () => Promise<string>, extras?: SendExtras): Promise<boolean> => {
    let sent = false;
    await guard(async () => {
      const chatId = view.chat?.id ?? (await ensure());
      const c = current.current;
      c.draft = "";
      c.saved = "";
      clearTimeout(c.timer);
      setDraftState("");
      try {
        await client.send(chatId, text, context, { files: extras?.files.map((f) => f.id), mentions: extras?.mentions.map((t) => t.id) });
      } catch (e) {
        if (current.current.chatId === chatId && current.current.draft === "") setDraft(text);
        throw e;
      }
      sent = true;
    });
    return sent;
  };

  const stop = () => guard(async () => view.chat && client.cancel(view.chat.id));
  const decide = (approvalId: string, approved: boolean) => guard(() => client.decide(approvalId, approved));
  const setSettings = (patch: Partial<ChatSettings>, apply: (patch: Partial<ChatSettings>) => void = () => {}) =>
    guard(async () => {
      if (!view.chat) return apply(patch);
      const chat = await client.patchChat(view.chat.id, { settings: patch });
      setView((v) => (v.chat?.id === chat.id ? { ...v, chat: { ...v.chat, settings: chat.settings, title: chat.title } } : v));
    });

  useEffect(() => () => void saveDraft(), [saveDraft]);

  return { view, setView, show, unsent, onEvent, draft, setDraft, saveDraft, send, stop, decide, setSettings, error, setError, frame, run: guard };
}
