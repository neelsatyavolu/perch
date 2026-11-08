/**
 * The live thumbnail (spec 6.1, first moment; plan 3b task 13). While a chat's task runs, perchd
 * screencasts the tab the agent is driving (JPEG, 2 fps, 240 px wide) and sends each frame to the
 * pages as `run.frame`. It works for background tabs because the browser holds agent tabs drawing
 * (`Perch.claimTab`). The agent may move to another tab, so the driven tab is looked at again
 * every `pollMs`, and the cast follows it.
 */

import type { CdpConnection } from "../cdp/connection";
import type { AppEvent, ChatStatus } from "./protocol";

/** The parts of a Tab (src/browser/tab.ts) a screencast needs. */
export type CastTab = {
  readonly id: string;
  readonly session: string;
  readonly closed: boolean;
  readonly conn: Pick<CdpConnection, "on">;
  send<T = unknown>(method: string, params?: object): Promise<T>;
};

export type ThumbnailOptions = {
  emit: (event: AppEvent) => void;
  /** The tab a chat's run is driving now, if any. */
  driving: (chatId: string) => CastTab | null;
  pollMs?: number;
  /** At most this often, so a busy page cannot flood the pages. */
  minFrameMs?: number;
};

type Cast = { tab: CastTab; stop: () => void };

const CAST = { format: "jpeg", quality: 60, maxWidth: 240, maxHeight: 240, everyNthFrame: 1 };

export class LiveThumbnails {
  private readonly casts = new Map<string, Cast | null>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: ThumbnailOptions) {}

  /** RunManager's `onStatus`: cast while a chat is busy, stop when it is idle. */
  readonly update = (chatId: string, status: ChatStatus): void => {
    if (status === "idle") {
      this.end(chatId);
    } else if (!this.casts.has(chatId)) {
      this.casts.set(chatId, null);
      void this.follow(chatId);
    }
    this.schedule();
  };

  /** Moves each busy chat's cast to the tab its run drives now. */
  async refresh(): Promise<void> {
    await Promise.all([...this.casts.keys()].map((chatId) => this.follow(chatId)));
  }

  stop(): void {
    for (const chatId of [...this.casts.keys()]) this.end(chatId);
    this.schedule();
  }

  private async follow(chatId: string): Promise<void> {
    if (!this.casts.has(chatId)) return;
    const tab = this.opts.driving(chatId);
    const current = this.casts.get(chatId) ?? null;
    if (current && tab && current.tab === tab && !tab.closed) return;
    current?.stop();
    this.casts.set(chatId, null);
    if (!tab || tab.closed) return;
    const cast = this.start(chatId, tab);
    this.casts.set(chatId, cast);
    try {
      await tab.send("Page.startScreencast", CAST);
    } catch {
      // A tab that closed or refused: try again on the next look.
      cast.stop();
      if (this.casts.get(chatId) === cast) this.casts.set(chatId, null);
    }
  }

  private start(chatId: string, tab: CastTab): Cast {
    let last = 0;
    const minGap = this.opts.minFrameMs ?? 450;
    const off = tab.conn.on("Page.screencastFrame", (p: { data?: string; sessionId?: number }, sid?: string) => {
      if (sid !== tab.session || typeof p.sessionId !== "number") return;
      // Every frame is acknowledged, or Chromium stops sending them.
      void tab.send("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => undefined);
      const now = Date.now();
      if (typeof p.data !== "string" || now - last < minGap) return;
      last = now;
      this.opts.emit({ type: "run.frame", chatId, tabId: tab.id, data: p.data });
    });
    return {
      tab,
      stop: () => {
        off();
        if (!tab.closed) void tab.send("Page.stopScreencast").catch(() => undefined);
      },
    };
  }

  private end(chatId: string): void {
    if (!this.casts.has(chatId)) return;
    this.casts.get(chatId)?.stop();
    this.casts.delete(chatId);
    this.opts.emit({ type: "run.frame", chatId, tabId: null, data: null });
  }

  private schedule(): void {
    if (this.casts.size && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.opts.pollMs ?? 1000);
      this.timer.unref?.();
    } else if (!this.casts.size && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
