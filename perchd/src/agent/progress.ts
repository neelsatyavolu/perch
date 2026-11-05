/**
 * Notes that keep a task on track, added to tool results: how much of the step and time budget
 * is left, and when the agent keeps making the same call with the same result. Long research tasks
 * that ran out of time with no answer at all, and agents stuck retrying one dead click, were two of
 * the commonest failures in the benchmark runs. Used by Perch's own loop and by the MCP server.
 */

import type { ToolCall } from "../models/types";

export type Budget = { maxSteps?: number; maxMs?: number };

/** Fractions of the budget at which the agent is told to wrap up, then to answer now. */
const WRAP_UP = 0.7;
const ANSWER_NOW = 0.9;
/** How many recent calls are compared, and how often one may repeat with the same result. */
const WINDOW = 8;
const REPEATS = 3;
/** Calls whose identical results are expected (a canvas changing under the same screenshot call). */
const UNCHECKED = new Set(["screenshot", "wait_for", "tabs", "write_file", "done"]);

export const REPEATED =
  "You have made this same call with the same result several times. It is not working: try a different approach (another element, the site's search, a URL with parameters, another site), or finish with what you have.";

export class Progress {
  private steps = 0;
  private readonly started: number;
  private readonly recent: string[] = [];
  private level = 0;
  /** Time spent waiting for the user, which is not the agent's time. */
  private pausedMs = 0;
  private pausedAt: number | null = null;

  constructor(private readonly budget: Budget, private readonly now: () => number = Date.now) {
    this.started = now();
  }

  /** Records a finished call and returns notes for its result, most important first. */
  after(call: ToolCall, result: string): string[] {
    this.steps += 1;
    const notes: string[] = [];
    const budget = this.budgetNote();
    if (budget) notes.push(budget);
    if (this.repeated(call, result)) notes.push(REPEATED);
    return notes;
  }

  /** Runs work (an approval prompt) with the clock stopped. */
  async whilePaused<T>(work: () => Promise<T>): Promise<T> {
    if (this.pausedAt !== null) return work();
    this.pausedAt = this.now();
    try {
      return await work();
    } finally {
      this.pausedMs += this.now() - this.pausedAt;
      this.pausedAt = null;
    }
  }

  private elapsed(): number {
    const paused = this.pausedMs + (this.pausedAt === null ? 0 : this.now() - this.pausedAt);
    return this.now() - this.started - paused;
  }

  /** The share of the budget used, by whichever of steps and time is further along. */
  used(): number {
    const bySteps = this.budget.maxSteps ? this.steps / this.budget.maxSteps : 0;
    const byTime = this.budget.maxMs ? this.elapsed() / this.budget.maxMs : 0;
    return Math.max(bySteps, byTime);
  }

  timeUp(): boolean {
    return this.budget.maxMs !== undefined && this.elapsed() >= this.budget.maxMs;
  }

  private budgetNote(): string | null {
    const used = this.used();
    const next = used >= ANSWER_NOW ? 2 : used >= WRAP_UP ? 1 : 0;
    if (next <= this.level) return null;
    this.level = next;
    const left = this.left();
    return next === 2
      ? `Budget: ${left} left. Answer now with what pages have shown, and say what is unverified.`
      : `Budget: ${left} left. Start wrapping up: get only what is still missing, then answer.`;
  }

  /** What is left of whichever budget is running out first. */
  private left(): string {
    const bySteps = this.budget.maxSteps ? this.steps / this.budget.maxSteps : 0;
    const byTime = this.budget.maxMs ? this.elapsed() / this.budget.maxMs : 0;
    if (this.budget.maxSteps && bySteps >= byTime) return `${Math.max(0, this.budget.maxSteps - this.steps)} of ${this.budget.maxSteps} steps`;
    const maxMs = this.budget.maxMs ?? 0;
    const minutes = Math.max(0, Math.round((maxMs - this.elapsed()) / 60_000));
    return `about ${minutes} of ${Math.round(maxMs / 60_000)} minutes`;
  }

  private repeated(call: ToolCall, result: string): boolean {
    if (UNCHECKED.has(call.name)) return false;
    const key = `${call.name} ${JSON.stringify(call.args)} ${Bun.hash(result)}`;
    this.recent.push(key);
    if (this.recent.length > WINDOW) this.recent.shift();
    return this.recent.filter((k) => k === key).length >= REPEATS;
  }
}
