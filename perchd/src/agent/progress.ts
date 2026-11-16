/**
 * Notes that keep a task on track, added to tool results: how much of the step and time budget
 * is left, and when the agent is stuck: the same call with the same result, failure after failure,
 * or one element worked again and again. Long research tasks that ran out of time with no answer
 * at all, and agents stuck retrying one dead click, were two of the commonest failures in the
 * benchmark runs. Used by Perch's own loop, the MCP server and sidebar runs of outside agents.
 */

import type { ToolCall } from "../models/types";
import { DECLINED } from "./session";

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

/** Failed calls in a row before the agent is told to step back. */
const FAILS = 3;
export const FAILING =
  "Your last 3 actions failed. Stop trying variations of the same thing: take a fresh snapshot to see where you are, then get what you need another way (another page, the site's search, a URL with parameters, a web search, another site), or finish with what you have.";

/** Actions on one element within the window before the agent is asked whether it needs it. */
const SAME_TARGET = 4;
export const SAME_ELEMENT =
  "You have worked the same element 4 times in the last few steps. If it still is not doing what you need, check whether the user's question needs it at all: a page or search result that states the answer, or another site, is often quicker. Otherwise set it another way (a URL parameter, a different control).";

export class Progress {
  private steps = 0;
  private readonly started: number;
  private readonly recent: string[] = [];
  /** Element refs of recent actions, and the refs already warned about. */
  private readonly targets: string[] = [];
  private readonly warned = new Set<string>();
  private failures = 0;
  private level = 0;
  /** Time spent waiting for the user, which is not the agent's time. */
  private pausedMs = 0;
  private pausedAt: number | null = null;

  constructor(private readonly budget: Budget, private readonly now: () => number = Date.now) {
    this.started = now();
  }

  /**
   * Records a finished call and returns notes for its result, most important first. At most one
   * note about being stuck: the most specific one that applies.
   */
  after(call: ToolCall, result: string, isError = false): string[] {
    this.steps += 1;
    // A declined action is the user's choice, not a failure to work around another way.
    this.failures = isError && !result.includes(DECLINED) ? this.failures + 1 : 0;
    const notes: string[] = [];
    const budget = this.budgetNote();
    if (budget) notes.push(budget);
    const repeated = this.repeated(call, result);
    const sameTarget = this.sameTarget(call);
    if (repeated) notes.push(REPEATED);
    else if (this.failures >= FAILS && this.failures % FAILS === 0) notes.push(FAILING);
    else if (sameTarget) notes.push(SAME_ELEMENT);
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

  /** True the first time one element has been acted on SAME_TARGET times within the window. */
  private sameTarget(call: ToolCall): boolean {
    if (UNCHECKED.has(call.name) || typeof call.args.ref !== "string") return false;
    const ref = call.args.ref;
    this.targets.push(ref);
    if (this.targets.length > WINDOW) this.targets.shift();
    if (this.warned.has(ref) || this.targets.filter((r) => r === ref).length < SAME_TARGET) return false;
    this.warned.add(ref);
    return true;
  }

  private repeated(call: ToolCall, result: string): boolean {
    if (UNCHECKED.has(call.name)) return false;
    const key = `${call.name} ${JSON.stringify(call.args)} ${Bun.hash(result)}`;
    this.recent.push(key);
    if (this.recent.length > WINDOW) this.recent.shift();
    return this.recent.filter((k) => k === key).length >= REPEATS;
  }
}
