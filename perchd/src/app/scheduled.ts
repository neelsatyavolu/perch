/**
 * Messages a chat sends itself later ("publish the draft at 12am"): the agent schedules one with
 * schedule_message, and at that time Perch sends it into the same chat as if the user had. One the
 * user approved up front runs without stopping to ask before sends, posts and publishing
 * (payments and password changes still ask). Kept in the chat record, so they survive restarts.
 */

import type { ChatStore } from "./chats";
import type { ChatMessage, ScheduledMessage } from "./protocol";

export const MAX_AHEAD_MS = 31 * 24 * 3_600_000;
/** A message whose time passed while the Mac slept runs when Perch next looks, unless it is this late. */
export const STALE_MS = 12 * 3_600_000;
const TICK_MS = 30_000;

export type SchedulerDeps = {
  chats: ChatStore;
  /** Sends a due message; resolves false when the chat is busy (it is tried again next tick). */
  send: (chatId: string, item: ScheduledMessage) => Promise<boolean>;
  /** A note for a message that came too late to send. */
  missed: (chatId: string, note: ChatMessage) => Promise<void>;
  now?: () => number;
};

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), TICK_MS);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async add(chatId: string, at: Date, text: string, preapproved: boolean): Promise<ScheduledMessage> {
    const when = at.getTime();
    if (!Number.isFinite(when)) throw new Error("That time isn't a date and time Perch can read; use one like 2026-11-11T00:00.");
    if (when <= this.now()) throw new Error("That time has already passed.");
    if (when - this.now() > MAX_AHEAD_MS) throw new Error("Perch can schedule up to 31 days ahead.");
    const item: ScheduledMessage = { id: crypto.randomUUID(), at: new Date(when).toISOString(), text, ...(preapproved ? { preapproved: true } : {}) };
    await this.deps.chats.update(chatId, (c) => ({ ...c, scheduled: [...(c.scheduled ?? []), item] }));
    return item;
  }

  /** Sends what is due. Runs every 30 s and when started, so a sleeping Mac catches up on waking. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      for (const chat of this.deps.chats.list()) {
        for (const item of chat.scheduled ?? []) {
          const at = Date.parse(item.at);
          if (at > now) continue;
          if (now - at > STALE_MS) {
            await this.remove(chat.id, item.id);
            await this.deps.missed(chat.id, {
              id: crypto.randomUUID(),
              role: "assistant",
              text: `I didn't send the message scheduled for ${new Date(at).toLocaleString()} because Perch wasn't running then: "${item.text}". Send it again if you still want it.`,
              time: new Date(now).toISOString(),
            });
            continue;
          }
          if (await this.deps.send(chat.id, item).catch(() => true)) await this.remove(chat.id, item.id);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  private async remove(chatId: string, id: string): Promise<void> {
    if (!this.deps.chats.get(chatId)) return;
    await this.deps.chats.update(chatId, (c) => ({ ...c, scheduled: (c.scheduled ?? []).filter((s) => s.id !== id) }));
  }
}
