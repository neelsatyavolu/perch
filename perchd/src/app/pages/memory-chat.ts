/**
 * Build my memory from the tour: a chat of its own that researches the user and saves as it goes
 * (memory/build-chat.ts), opened in a tab behind the current one so the person can carry on and
 * look in on it, or answer its questions, whenever they like.
 */

import { DEFAULT_SETTINGS } from "../chats";
import { MEMORY_BUILD_PROMPT, MEMORY_BUILD_TITLE } from "../../memory/build-chat";
import type { Methods } from "./common";
import type { PagesDeps } from "./deps";

export function memoryChatPages(deps: PagesDeps): Methods<"startMemoryChat"> {
  return {
    async startMemoryChat() {
      const defaults = deps.chatInfo?.().defaults;
      const chat = await deps.chats.create({
        title: MEMORY_BUILD_TITLE,
        settings: { ...DEFAULT_SETTINGS, ...(defaults ? { model: defaults.model, effort: defaults.effort, mode: defaults.mode } : {}) },
      });
      await deps.runs.send(chat.id, MEMORY_BUILD_PROMPT);
      await deps.openBackgroundTab?.(`chrome://perch-chat/?chat=${encodeURIComponent(chat.id)}`).catch(() => undefined);
      return { chatId: chat.id };
    },
  };
}
