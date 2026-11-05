/**
 * Agent sessions for outside clients. Each session works in its own tabs, grouped as
 * "<agent> · <title>" so the user sees which agent owns which tabs. A tab belongs to one
 * session at a time; a user's tab a session switches to is borrowed until the session ends.
 */

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { callTool, type CallPolicy } from "../agent/session";
import { newToolContext, type ToolContext, type ToolResult } from "../agent/tools";
import type { Browser } from "../browser/browser";
import type { ToolCall } from "../models/types";
import { groupLabel, type OnEnd } from "./protocol";

export type SessionInfo = { client: string; session: string; agent: string; title: string; persistent: boolean; onEnd: OnEnd };
export type SessionSummary = { client: string; session: string; agent: string; title: string; label: string; tabs: number; asleep: boolean; lastUsed: string };

/** Draws a tab group in the browser. Perch's patches add `Perch.setTabGroup` (plan 3b). */
export type TabGroups = { apply(targetIds: string[], label: string): Promise<void> };

export class AgentSession {
  ctx: ToolContext | null = null;
  borrowed = new Set<string>();
  asleep = false;
  /** Open connections working in this session. */
  connections = 0;
  lastUsed = Date.now();
  endTimer: ReturnType<typeof setTimeout> | null = null;
  queue: Promise<unknown> = Promise.resolve();

  constructor(readonly info: SessionInfo) {}

  get key(): string {
    return `${this.info.client}/${this.info.session}`;
  }

  get label(): string {
    return groupLabel(this.info.agent, this.info.title);
  }

  /** Open tabs this session made, then tabs it borrowed. */
  tabIds(): string[] {
    const own = (this.ctx?.owned ?? []).filter((t) => !t.closed).map((t) => t.id);
    return [...new Set([...own, ...this.borrowed])];
  }
}

export type ManagerOptions = {
  browser: () => Promise<Browser>;
  sessionsFile: string;
  groups?: TabGroups;
  /** Sessions kept between CLI commands sleep after this long unused. */
  idleSleepMs?: number;
};

const NOT_YOURS = (label: string) => `That tab belongs to "${label}". Open your own with open_tab.`;

export class SessionManager {
  private sessions = new Map<string, AgentSession>();
  private readonly idleTimer: ReturnType<typeof setInterval>;

  constructor(private readonly opts: ManagerOptions) {
    const idle = opts.idleSleepMs ?? 30 * 60_000;
    this.idleTimer = setInterval(() => void this.sleepIdle(idle), Math.min(idle, 60_000));
    this.idleTimer.unref?.();
  }

  /** Gets or starts a session; reopening one cancels a pending end and keeps its tabs. */
  open(info: SessionInfo): AgentSession {
    const key = `${info.client}/${info.session}`;
    const existing = this.sessions.get(key);
    if (existing) {
      if (existing.endTimer) clearTimeout(existing.endTimer);
      existing.endTimer = null;
      return existing;
    }
    const session = new AgentSession(info);
    this.sessions = new Map(this.sessions).set(key, session);
    this.writeFile();
    return session;
  }

  get(client: string, session: string): AgentSession | undefined {
    return this.sessions.get(`${client}/${session}`);
  }

  list(): SessionSummary[] {
    return [...this.sessions.values()].map((s) => ({
      client: s.info.client,
      session: s.info.session,
      agent: s.info.agent,
      title: s.info.title,
      label: s.label,
      tabs: s.tabIds().length,
      asleep: s.asleep,
      lastUsed: new Date(s.lastUsed).toISOString(),
    }));
  }

  /** The session that owns or borrowed a tab. */
  owner(tabId: string): AgentSession | undefined {
    return [...this.sessions.values()].find((s) => s.tabIds().includes(tabId));
  }

  /** Runs one tool call in a session, one at a time per session, under the client's policy. */
  call(session: AgentSession, call: ToolCall, policy: CallPolicy): Promise<ToolResult> {
    const run = session.queue.then(() => this.run(session, call, policy));
    session.queue = run.catch(() => undefined);
    return run;
  }

  private async run(session: AgentSession, call: ToolCall, policy: CallPolicy): Promise<ToolResult> {
    session.lastUsed = Date.now();
    const ctx = await this.context(session);
    if (session.asleep) await this.wake(session);
    let borrowing: string | null = null;
    if (call.name === "switch_tab" && typeof call.args.id === "string") {
      const owner = this.owner(call.args.id);
      if (owner && owner !== session) return { content: NOT_YOURS(owner.label), isError: true };
      if (!owner && !ctx.owned.some((t) => t.id === call.args.id)) {
        // Claimed before the await, so a second session sees it as taken.
        borrowing = call.args.id;
        session.borrowed.add(borrowing);
      }
    }
    const before = new Set(session.tabIds());
    const result = await callTool(ctx, policy, call);
    if (borrowing && result.isError) session.borrowed.delete(borrowing);
    const added = session.tabIds().filter((id) => !before.has(id));
    if (added.length) await this.group(session, added);
    this.writeFile();
    if (call.name === "tabs" && !result.isError) return { content: await this.tabs(session) };
    return result;
  }

  /** Every open tab, marked with the session that owns it. */
  async tabs(session?: AgentSession): Promise<string> {
    const browser = await this.opts.browser();
    const current = session?.ctx?.tab?.id;
    const lines = (await browser.tabs()).map((t) => {
      const owner = this.owner(t.id);
      const whose = !owner ? "the user's" : owner === session ? "yours" : `${owner.label}, not yours`;
      return `${t.id === current ? "* " : "  "}${t.id} ${t.title || "(untitled)"} · ${t.url} (${whose})`;
    });
    return lines.join("\n");
  }

  /** Brings a session's current tab forward. Returns the tab id. */
  async focus(session: AgentSession): Promise<string> {
    const browser = await this.opts.browser();
    const ids = session.tabIds();
    const id = session.ctx?.tab && !session.ctx.tab.closed ? session.ctx.tab.id : ids[ids.length - 1];
    if (!id) throw new Error(`"${session.label}" has no open tabs`);
    if (session.asleep) await this.wake(session);
    await browser.conn.send("Target.activateTarget", { targetId: id });
    return id;
  }

  /** Ends a session after `ms` unless it is opened again first (an MCP client restarting). */
  scheduleEnd(session: AgentSession, ms: number): void {
    if (session.endTimer) clearTimeout(session.endTimer);
    session.endTimer = setTimeout(() => void this.end(session, session.info.onEnd), ms);
  }

  /** Close: the session's own tabs close and it is forgotten. Sleep: its tabs freeze and stay listed. */
  async end(session: AgentSession, how: OnEnd = session.info.onEnd): Promise<void> {
    if (session.endTimer) clearTimeout(session.endTimer);
    session.endTimer = null;
    session.borrowed = new Set();
    // A released borrowed tab is the user's again; the session must not keep acting on it.
    const ctx = session.ctx;
    if (ctx?.tab && !ctx.owned.includes(ctx.tab)) ctx.tab = ctx.owned.filter((t) => !t.closed).at(-1) ?? null;
    if (how === "sleep") {
      await this.freeze(session, true);
      session.asleep = true;
    } else {
      await session.ctx?.close().catch(() => undefined);
      const next = new Map(this.sessions);
      next.delete(session.key);
      this.sessions = next;
    }
    this.writeFile();
  }

  async closeAll(): Promise<void> {
    clearInterval(this.idleTimer);
    await Promise.all([...this.sessions.values()].map((s) => this.end(s, "close")));
  }

  /** Drops every session without touching tabs, after the browser went away. */
  forgetAll(): void {
    for (const s of this.sessions.values()) if (s.endTimer) clearTimeout(s.endTimer);
    this.sessions = new Map();
    this.writeFile();
  }

  private async context(session: AgentSession): Promise<ToolContext> {
    session.ctx ??= await newToolContext(await this.opts.browser());
    return session.ctx;
  }

  private async group(session: AgentSession, ids: string[]): Promise<void> {
    await this.opts.groups?.apply(ids, session.label).catch(() => undefined);
  }

  private async wake(session: AgentSession): Promise<void> {
    await this.freeze(session, false);
    session.asleep = false;
    this.writeFile();
  }

  private async freeze(session: AgentSession, frozen: boolean): Promise<void> {
    const tabs = (session.ctx?.owned ?? []).filter((t) => !t.closed);
    await Promise.all(tabs.map((t) => t.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" }).catch(() => undefined)));
  }

  private async sleepIdle(idleMs: number): Promise<void> {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (!s.info.persistent && !s.asleep && now - s.lastUsed > idleMs && s.tabIds().length) await this.end(s, "sleep");
    }
  }

  /** What agterm and agmux read for their browser marks: counts only, no pages. */
  private writeFile(): void {
    const file = this.opts.sessionsFile;
    try {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp-${process.pid}`;
      const sessions = this.list().map(({ lastUsed: _, ...s }) => s);
      writeFileSync(tmp, `${JSON.stringify({ version: 1, updated: new Date().toISOString(), sessions }, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
    } catch {
      // The indicator file is a convenience; a failed write never fails a tool call.
    }
  }
}

/** Tab groups through Perch's CDP domain; in a browser without it, labels stay in perchd. */
export function cdpTabGroups(browser: () => Promise<Browser>): TabGroups {
  let supported = true;
  return {
    async apply(targetIds, label) {
      if (!supported) return;
      const b = await browser();
      await b.conn.send("Perch.setTabGroup", { targetIds, title: label }).catch(() => {
        supported = false;
      });
    },
  };
}
