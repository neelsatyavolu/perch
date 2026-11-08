/**
 * The perch dot (spec 6.1, plan 3b task 6). Tells the browser, through `Perch.setTaskStatus`, which
 * tabs each chat is working in and whether it is running or waiting for the user. The browser
 * paints the breathing dot on running tabs, a still dot on the profile button while a chat waits,
 * and one notice per waiting chat when Perch is in the background, titled with the card's title.
 *
 * Agent tabs come and go while a task runs, so a busy chat's tabs are looked at again every
 * `refreshMs`. Only changes go to the browser.
 */

import type { PerchDomainApi, TaskStatus } from "../browser/perch-domain";
import type { ApprovalCard, ChatStatus } from "./protocol";

export type TaskStatusOptions = {
  perch: Pick<PerchDomainApi, "setTaskStatus">;
  /** The CDP target ids a chat works in now: its own tab and the agent tabs of its run. */
  targets: (chatId: string) => string[];
  refreshMs?: number;
};

type Sent = { status: TaskStatus; targetIds: string[]; title?: string };

export class TaskStatusReporter {
  private readonly sent = new Map<string, Sent>();
  private readonly cards = new Map<string, ApprovalCard | null>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: TaskStatusOptions) {}

  /** RunManager's `onStatus`. */
  readonly update = (chatId: string, status: ChatStatus, card: ApprovalCard | null): void => {
    this.cards.set(chatId, card);
    this.push(chatId, status);
    if (status === "idle") this.cards.delete(chatId);
    this.schedule();
  };

  /** Looks again at the tabs of every busy chat. */
  refresh(): void {
    for (const [chatId, sent] of this.sent) if (sent.status !== "idle") this.push(chatId, sent.status);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private push(chatId: string, status: TaskStatus): void {
    const before = this.sent.get(chatId);
    if (status === "idle" && !before) return;
    // Idle names the tabs that had the dot, so the browser clears exactly those.
    const targetIds = status === "idle" ? before?.targetIds ?? [] : [...new Set(this.safeTargets(chatId))].sort();
    const title = status === "waiting" ? this.cards.get(chatId)?.title : undefined;
    const next: Sent = { status, targetIds, ...(title ? { title } : {}) };
    if (before && same(before, next)) return;
    if (status === "idle") this.sent.delete(chatId);
    else this.sent.set(chatId, next);
    void this.opts.perch.setTaskStatus({ chatId, ...next }).catch(() => undefined);
  }

  private safeTargets(chatId: string): string[] {
    try {
      return this.opts.targets(chatId);
    } catch {
      return [];
    }
  }

  private schedule(): void {
    const busy = [...this.sent.values()].some((s) => s.status !== "idle");
    if (busy && !this.timer) {
      this.timer = setInterval(() => this.refresh(), this.opts.refreshMs ?? 2000);
      this.timer.unref?.();
    } else if (!busy) this.stop();
  }
}

function same(a: Sent, b: Sent): boolean {
  return a.status === b.status && a.title === b.title && a.targetIds.join(",") === b.targetIds.join(",");
}
