/**
 * Runs: one agent task per chat at a time. A run streams its events to every open page, waits
 * for the user at approvals, stops on cancel, and keeps going when no page is watching (a side
 * chat's task continues while its tab is in the background, spec 5.3).
 */

import { Scheduler } from "./scheduled";
import type { Mode } from "../agent/permissions";
import { provisionalTitle, takeTitleLine } from "./chat-title";
import type { StepEvent } from "../agent/loop";
import type { ApprovalRequest } from "../agent/session";
import { describeApproval } from "./approval-card";
import { parseArtifactBlocks, type ArtifactRecord, type ArtifactStore } from "./artifacts";
import type { ChatStore } from "./chats";
import type { AppEvent, ApprovalCard, ArtifactMeta, Chat, ChatMessage, ChatSettings, ChatStatus, ChatSummary, QueuedMessage, RunSnapshot, ScheduledMessage, Step, TabInfo } from "./protocol";
import { buildTask } from "./transcript";

export type RunnerInput = {
  task: string;
  /** The user's own message, without the history and instructions `task` adds: what memory is searched and taught with. */
  ask?: string;
  /** Files the user attached to this message, by name and path on this Mac. */
  files?: { name: string; path: string }[];
  /** Schedules a message for this chat (scheduled.ts); the agent's schedule_message tool. */
  schedule?: (at: Date, text: string, preapproved: boolean) => Promise<ScheduledMessage>;
  settings: ChatSettings;
  approve: (req: ApprovalRequest) => Promise<boolean>;
  signal: AbortSignal;
  /** The user's tab the task works in, for the "current tab" scope when the browser named its target. */
  tab?: TabInfo;
  /** The chat this run belongs to, so the browser can mark the tabs it works in (the perch dot). */
  chatId?: string;
  /** A private chat (spec 5.8): no memory in or out, and no page text in the audit log. */
  incognito?: boolean;
};
export type Runner = (input: RunnerInput) => AsyncIterable<StepEvent>;

export type RunDeps = {
  chats: ChatStore;
  artifacts: ArtifactStore;
  runner: Runner;
  emit: (event: AppEvent) => void;
  artifactUrl: (id: string, version: number) => string;
  /** The tabs the browser reported, for the "all tabs" scope. */
  tabs: () => TabInfo[];
  /** Every status change of a chat, with its card while one waits: the browser's perch dot and notices. */
  onStatus?: (chatId: string, status: ChatStatus, card: ApprovalCard | null) => void;
  /** The readable text of the user's tab (page-text.ts), sent with the message; null when it can't be read. */
  pageText?: (targetId: string) => Promise<string | null>;
  /** Names a chat from its first message and reply (chat-title.ts); null or a throw keeps the first-message title. */
  nameChat?: (ask: string, reply: string) => Promise<string | null>;
};

/** What a message brings beyond its text: attached files (resolved to paths) and @ tabs. */
/** `mode` runs this message under another mode (a scheduled message the user pre-approved); `scheduled` marks it. */
export type SendExtras = { files?: { id: string; name: string; path: string }[]; mentions?: TabInfo[]; mode?: Mode; scheduled?: boolean };

export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type Pending = { card: ApprovalCard; resolve: (approved: boolean) => void; done?: Promise<void> };
/** `holdBack`: the user asked for the work without the final submit or send ("complete it without submitting"). */
type Run = { runId: string; chatId: string; controller: AbortController; text: string; steps: Step[]; pending: Pending | null; done: Promise<void>; startedAt: string; holdBack?: boolean };

/** "without submitting", "don't send it", "do not turn it in": the user wants the last step left to them. */
const HOLD_BACK = /\b(without|don'?t|do not|never|not|no)\b[^.\n]{0,24}?\b(submit(ting)?|turn(ing)? (it |this |them )?in|hand(ing)? (it |this |them )?in|send(ing)?|post(ing)?|publish(ing)?)\b/i;
/** The final steps a held-back run leaves to the user. */
const FINAL_STEP = /\b(submit|turn in|hand in|send|post|publish|go live|push live|make live|deploy)\b/i;
const HOLD_BACK_NOTE =
  "The user wants this done without the final submit or send: do everything up to that point, leave the submit, send or publish step for them, and say it is ready.";

const MAX_MESSAGE = 50_000;
/** Messages that can wait behind one chat's task. */
const MAX_QUEUED = 10;

/** A queued message with what it is sent with once its turn comes. */
type Waiting = QueuedMessage & { context?: TabInfo; extras: SendExtras };

export class RunManager {
  private readonly naming = new Set<Promise<void>>();
  private runs = new Map<string, Run>();
  /** Cards for work that runs outside a chat's own run: an outside agent's action, a new client. */
  private held = new Map<string, Pending>();
  /** Messages sent while a chat's task runs, sent in order once it ends. */
  private queues = new Map<string, readonly Waiting[]>();
  /** Chats whose run is being stopped to steer, so the queue waits for the steering message. */
  private steering = new Set<string>();

  readonly scheduler: Scheduler;

  constructor(private readonly deps: RunDeps) {
    this.scheduler = new Scheduler({
      chats: deps.chats,
      send: async (chatId, item) => {
        if (this.runs.has(chatId)) return false;
        await this.send(chatId, item.text, undefined, { scheduled: true, ...(item.preapproved ? { mode: "skip" as const } : {}) });
        return true;
      },
      missed: async (chatId, note) => {
        await this.deps.chats.update(chatId, (c) => ({ ...c, messages: [...c.messages, note] }));
        this.deps.emit({ type: "run.finished", chatId, runId: `missed-${note.id}`, message: note });
        this.announce(chatId);
      },
    });
  }

  status(chatId: string): ChatStatus {
    const run = this.runs.get(chatId);
    if (!run) return this.held.has(chatId) ? "waiting" : "idle";
    return run.pending ? "waiting" : "running";
  }

  snapshot(chatId: string): RunSnapshot | null {
    const run = this.runs.get(chatId);
    const queued = this.queued(chatId);
    if (run) return { runId: run.runId, chatId, text: run.text, steps: run.steps, approval: run.pending?.card ?? null, startedAt: run.startedAt, ...(queued.length ? { queued } : {}) };
    const held = this.held.get(chatId);
    return held ? { runId: held.card.runId, chatId, text: "", steps: [], approval: held.card } : null;
  }

  /**
   * Shows a card in a chat that has no run of its own going, and waits for the user's answer.
   * Outside agents without their own prompt (Codex) and new clients ask the user this way.
   * One card per chat at a time: a second waits for the first.
   */
  async hold(chatId: string, card: Omit<ApprovalCard, "id" | "chatId" | "runId">, signal?: AbortSignal): Promise<boolean> {
    if (!this.deps.chats.get(chatId)) throw new AppError(`no chat ${chatId}`, 404);
    while (this.held.has(chatId)) await this.held.get(chatId)!.done;
    if (signal?.aborted) return false;
    const full: ApprovalCard = { ...card, id: crypto.randomUUID(), chatId, runId: `held-${crypto.randomUUID()}` };
    let settle!: () => void;
    const done = new Promise<void>((r) => (settle = r));
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        if (this.held.get(chatId)?.card.id !== full.id) return;
        this.held.delete(chatId);
        signal?.removeEventListener("abort", onAbort);
        this.deps.emit({ type: "run.approval.resolved", chatId, runId: full.runId, approvalId: full.id, approved });
        this.announce(chatId);
        settle();
        resolve(approved);
      };
      const onAbort = () => finish(false);
      this.held.set(chatId, { card: full, resolve: finish, done });
      signal?.addEventListener("abort", onAbort, { once: true });
      this.deps.emit({ type: "run.approval", chatId, runId: full.runId, card: full });
      this.announce(chatId);
    });
  }

  summary(chat: Chat): ChatSummary {
    const last = chat.messages.at(-1);
    const status = this.status(chat.id);
    const reply = last?.role === "assistant" ? last : undefined;
    return {
      id: chat.id,
      title: chat.title,
      updatedAt: chat.updatedAt,
      tab: chat.tab,
      status,
      preview: (last?.text ?? "").replace(/\[\[artifact:[^\]]+\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 140),
      ...(chat.pinned ? { pinned: true as const } : {}),
      ...(reply && status === "idle" && (!chat.readAt || reply.time > chat.readAt) ? { unread: true as const } : {}),
      ...(reply?.error ? { failed: true as const } : {}),
    };
  }

  artifactMeta(record: ArtifactRecord): ArtifactMeta {
    const version = record.versions.length;
    return {
      id: record.id,
      chatId: record.chatId,
      title: record.title,
      kind: record.kind,
      ...(record.language ? { language: record.language } : {}),
      version,
      versions: version,
      updatedAt: record.versions[version - 1]!.time,
      url: this.deps.artifactUrl(record.id, version),
    };
  }

  async send(chatId: string, text: string, context?: TabInfo, extras: SendExtras = {}): Promise<{ runId: string; message: ChatMessage }> {
    const chat = this.deps.chats.get(chatId);
    if (!chat) throw new AppError(`no chat ${chatId}`, 404);
    if (!text.trim()) throw new AppError("The message is empty");
    if (text.length > MAX_MESSAGE) throw new AppError("The message is too long (50,000 characters at most)");
    if (this.runs.has(chatId)) throw new AppError("A task is still running in this chat. Wait for it or stop it first", 409);
    const files = extras.files ?? [];
    const mentions = (extras.mentions ?? []).map(withoutTarget);
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
      time: new Date().toISOString(),
      ...(context ? { context: withoutTarget(context) } : {}),
      ...(files.length ? { attachments: files.map((f) => ({ id: f.id, name: f.name })) } : {}),
      ...(mentions.length ? { mentions } : {}),
      ...(extras.scheduled ? { scheduled: true as const } : {}),
    };
    const tab = context?.targetId ? context : undefined;
    const holdBack = HOLD_BACK.test(text);
    const built = buildTask({ history: chat.messages, text, scope: chat.settings.scope, tab: context, tabs: this.deps.tabs(), inTab: Boolean(tab), mentions, files });
    const page = tab?.targetId && this.deps.pageText ? await this.deps.pageText(tab.targetId).catch(() => null) : null;
    const withPage = page ? `${page}\n\n${built}` : built;
    const task = holdBack ? `${HOLD_BACK_NOTE}\n\n${withPage}` : withPage;
    const run: Run = { runId: crypto.randomUUID(), chatId, controller: new AbortController(), text: "", steps: [], pending: null, done: Promise.resolve(), startedAt: new Date().toISOString(), ...(holdBack ? { holdBack } : {}) };
    this.runs.set(chatId, run);
    try {
      const updated = await this.deps.chats.update(chatId, (c) => ({
        ...c,
        title: c.title === "New chat" && c.messages.length === 0 ? provisionalTitle(text) : c.title,
        draft: "",
        messages: [...c.messages, message],
      }));
      this.deps.emit({ type: "run.started", chatId, runId: run.runId, message });
      this.deps.emit({ type: "chat.updated", chat: this.summary(updated) });
      this.deps.onStatus?.(chatId, "running", null);
    } catch (error) {
      this.runs.delete(chatId);
      throw error;
    }
    // Skip confirmation would let the submit through unasked, so a held-back run asks (and declines it).
    const chosen = extras.mode ? { ...chat.settings, mode: extras.mode } : chat.settings;
    const settings = holdBack && chosen.mode === "skip" ? { ...chosen, mode: "guard" as const } : chosen;
    run.done = this.drive(run, task, settings, tab, text, files.map((f) => ({ name: f.name, path: f.path })));
    return { runId: run.runId, message };
  }

  /** The messages waiting behind this chat's task, oldest first. */
  queued(chatId: string): QueuedMessage[] {
    return (this.queues.get(chatId) ?? []).map(({ id, text, time }) => ({ id, text, time }));
  }

  /**
   * Queue: while the chat's task runs, the message waits and is sent as the next turn when the
   * task ends (after anything queued before it). With nothing running it is sent at once.
   */
  async enqueue(chatId: string, text: string, context?: TabInfo, extras: SendExtras = {}): Promise<{ runId: string; message: ChatMessage } | { queued: QueuedMessage }> {
    if (!this.runs.has(chatId) && !this.queues.get(chatId)?.length) return this.send(chatId, text, context, extras);
    if (!this.deps.chats.get(chatId)) throw new AppError(`no chat ${chatId}`, 404);
    if (!text.trim()) throw new AppError("The message is empty");
    if (text.length > MAX_MESSAGE) throw new AppError("The message is too long (50,000 characters at most)");
    const waiting = this.queues.get(chatId) ?? [];
    if (waiting.length >= MAX_QUEUED) throw new AppError(`At most ${MAX_QUEUED} messages can wait in one chat`, 409);
    const item: Waiting = { id: crypto.randomUUID(), text, time: new Date().toISOString(), ...(context ? { context } : {}), extras };
    this.setQueue(chatId, [...waiting, item]);
    // A run that ended while this was being queued would not pick it up on its own.
    if (!this.runs.has(chatId)) void this.drain(chatId);
    return { queued: { id: item.id, text, time: item.time } };
  }

  /**
   * Steer: stop the task where it is (its steps so far stay in the chat) and send this message
   * now, as the next turn. Queued messages still follow it.
   */
  async steer(chatId: string, text: string, context?: TabInfo, extras: SendExtras = {}): Promise<{ runId: string; message: ChatMessage }> {
    if (!this.deps.chats.get(chatId)) throw new AppError(`no chat ${chatId}`, 404);
    if (!text.trim()) throw new AppError("The message is empty");
    const run = this.runs.get(chatId);
    if (run) {
      this.steering.add(chatId);
      try {
        run.controller.abort();
        run.pending?.resolve(false);
        await this.idleFor(chatId);
      } finally {
        this.steering.delete(chatId);
      }
    }
    return this.send(chatId, text, context, extras);
  }

  /** Sends a queued message now, steering the task with it. */
  async steerQueued(chatId: string, queuedId: string): Promise<{ runId: string; message: ChatMessage }> {
    const item = this.takeQueued(chatId, queuedId);
    if (!item) throw new AppError("That message is no longer waiting", 404);
    return this.steer(chatId, item.text, item.context, item.extras);
  }

  /** Takes a message out of the queue; false when it was not waiting. */
  unqueue(chatId: string, queuedId: string): boolean {
    return this.takeQueued(chatId, queuedId) !== undefined;
  }

  private takeQueued(chatId: string, queuedId: string): Waiting | undefined {
    const waiting = this.queues.get(chatId) ?? [];
    const item = waiting.find((w) => w.id === queuedId);
    if (item) this.setQueue(chatId, waiting.filter((w) => w.id !== queuedId));
    return item;
  }

  private setQueue(chatId: string, waiting: readonly Waiting[]): void {
    if (waiting.length) this.queues.set(chatId, waiting);
    else this.queues.delete(chatId);
    this.deps.emit({ type: "run.queue", chatId, queued: this.queued(chatId) });
  }

  /** After a run ends: sends the next queued message, unless a steer is about to send its own. */
  private async drain(chatId: string): Promise<void> {
    if (this.runs.has(chatId) || this.steering.has(chatId)) return;
    const [next, ...rest] = this.queues.get(chatId) ?? [];
    if (!next) return;
    this.setQueue(chatId, rest);
    try {
      await this.send(chatId, next.text, next.context, next.extras);
    } catch {
      // The chat is gone, or a run started meanwhile: put it back if the chat still exists.
      if (this.deps.chats.get(chatId) && !this.runs.has(chatId)) return this.drain(chatId);
      if (this.deps.chats.get(chatId)) this.setQueue(chatId, [next, ...(this.queues.get(chatId) ?? [])]);
    }
  }

  /** The user's answer to an approval card. False when the card is not waiting any more. */
  decide(approvalId: string, approved: boolean): boolean {
    const held = [...this.held.values()].find((p) => p.card.id === approvalId);
    if (held) {
      held.resolve(approved);
      return true;
    }
    const run = [...this.runs.values()].find((r) => r.pending?.card.id === approvalId);
    if (!run?.pending) return false;
    run.pending.resolve(approved);
    return true;
  }

  /**
   * Stop. Messages waiting behind the task are not sent; their text comes back in `unsent` so the
   * composer can offer it again.
   */
  cancel(chatId: string): boolean {
    return this.stop(chatId).stopped;
  }

  stop(chatId: string): { stopped: boolean; unsent: string[] } {
    const unsent = (this.queues.get(chatId) ?? []).map((w) => w.text);
    if (unsent.length) this.setQueue(chatId, []);
    return { stopped: this.abort(chatId) || unsent.length > 0, unsent };
  }

  private abort(chatId: string): boolean {
    // Stop on a chat that only holds a card declines the card.
    const held = this.held.get(chatId);
    if (held && !this.runs.has(chatId)) {
      held.resolve(false);
      return true;
    }
    const run = this.runs.get(chatId);
    if (!run || run.controller.signal.aborted) return false;
    run.controller.abort();
    run.pending?.resolve(false);
    return true;
  }

  /** Resolves when this chat's run, if one is going, has finished. Other chats' runs do not count. */
  async idleFor(chatId: string): Promise<void> {
    while (this.runs.has(chatId)) await this.runs.get(chatId)!.done;
  }

  /** Resolves when every run that is going now has finished. */
  async idle(): Promise<void> {
    while (this.runs.size) await Promise.all([...this.runs.values()].map((r) => r.done));
  }

  private approve(run: Run) {
    return (request: ApprovalRequest): Promise<boolean> => {
      if (run.controller.signal.aborted) return Promise.resolve(false);
      // The user said not to submit: that step is left for them, without a card.
      if (run.holdBack && request.kind !== "read" && FINAL_STEP.test(`${request.target?.name ?? ""} ${request.summary}`)) {
        const label = `Left "${request.target?.name || "the final step"}" for you`;
        run.steps = [...run.steps, { label }];
        this.deps.emit({ type: "run.step", chatId: run.chatId, runId: run.runId, label });
        return Promise.resolve(false);
      }
      const card = describeApproval(request, { id: crypto.randomUUID(), chatId: run.chatId, runId: run.runId });
      return new Promise<boolean>((resolve) => {
        run.pending = {
          card,
          resolve: (approved) => {
            if (run.pending?.card.id !== card.id) return;
            run.pending = null;
            this.deps.emit({ type: "run.approval.resolved", chatId: run.chatId, runId: run.runId, approvalId: card.id, approved });
            this.announce(run.chatId);
            resolve(approved);
          },
        };
        this.deps.emit({ type: "run.approval", chatId: run.chatId, runId: run.runId, card });
        this.announce(run.chatId);
      });
    };
  }

  private async drive(run: Run, task: string, settings: ChatSettings, tab?: TabInfo, ask?: string, files: { name: string; path: string }[] = []): Promise<void> {
    let final: string | undefined;
    let error: string | undefined;
    try {
      const incognito = this.deps.chats.get(run.chatId)?.incognito === true;
      const schedule = (at: Date, text: string, preapproved: boolean) => this.scheduler.add(run.chatId, at, text, preapproved);
      const events = this.deps.runner({ task, ...(ask ? { ask } : {}), ...(files.length ? { files } : {}), schedule, settings, approve: this.approve(run), signal: run.controller.signal, chatId: run.chatId, ...(tab ? { tab } : {}), ...(incognito ? { incognito } : {}) });
      for await (const event of events) {
        if (event.type === "text") {
          run.text += event.delta;
          if (event.delta) this.deps.emit({ type: "run.text", chatId: run.chatId, runId: run.runId, delta: event.delta });
        } else if (event.type === "step") {
          const step: Step = { label: event.label, ...(event.detail ? { detail: event.detail } : {}) };
          run.steps = [...run.steps, step];
          this.deps.emit({ type: "run.step", chatId: run.chatId, runId: run.runId, label: step.label, ...(step.detail ? { detail: step.detail } : {}) });
        } else if (event.type === "step_output") {
          const last = run.steps.at(-1);
          if (last && event.output) {
            run.steps = [...run.steps.slice(0, -1), { ...last, output: event.output }];
            this.deps.emit({ type: "run.step.output", chatId: run.chatId, runId: run.runId, output: event.output });
          }
        } else if (event.type === "final") {
          final = event.text;
        } else if (event.type === "error") {
          error = event.message;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    try {
      await this.finish(run, final, error);
    } finally {
      this.runs.delete(run.chatId);
      this.announce(run.chatId);
      void this.drain(run.chatId);
    }
  }

  private async finish(run: Run, final: string | undefined, error: string | undefined): Promise<void> {
    const stopped = run.controller.signal.aborted;
    // A new chat's first reply starts with the agent's `Title:` line (transcript.ts TITLE_FORMAT).
    const firstReply = this.deps.chats.get(run.chatId)?.messages.length === 1;
    const titled = firstReply ? takeTitleLine(final ?? run.text.trim()) : { title: null, text: final ?? run.text.trim() };
    const parsed = parseArtifactBlocks(titled.text);
    const ids: string[] = [];
    let text = parsed.text;
    for (const [i, block] of parsed.blocks.entries()) {
      try {
        const record = await this.deps.artifacts.save({ chatId: run.chatId, ...block });
        ids.push(record.id);
        text = text.replace(`[[artifact:#${i}]]`, `[[artifact:${record.id}]]`);
        this.deps.emit({ type: "artifact.saved", chatId: run.chatId, artifact: this.artifactMeta(record) });
      } catch (e) {
        text = text.replace(`[[artifact:#${i}]]`, `(The artifact "${block.title}" could not be saved: ${(e as Error).message}.)`);
      }
    }
    const message: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text,
      time: new Date().toISOString(),
      ...(run.steps.length ? { steps: run.steps } : {}),
      ...(ids.length ? { artifacts: ids } : {}),
      ...(stopped ? { stopped: true } : error ? { error } : {}),
    };
    const updated = await this.deps.chats.update(run.chatId, (c) => ({ ...c, messages: [...c.messages, message] }));
    this.deps.emit({ type: "run.finished", chatId: run.chatId, runId: run.runId, message });
    if (titled.title) await this.rename(updated, titled.title);
    else if (!stopped && !error && text.trim()) this.nameAfterFirstReply(updated, text);
  }

  /**
   * After the first reply, the fast model names the chat. The first-message title stays when the
   * user renamed the chat meanwhile, the chat is private, or the model can't help.
   */
  private nameAfterFirstReply(chat: Chat, reply: string): void {
    const ask = chat.messages[0];
    if (!this.deps.nameChat || chat.incognito || chat.messages.length !== 2 || ask?.role !== "user") return;
    const provisional = provisionalTitle(ask.text);
    if (chat.title !== provisional) return;
    const naming = this.deps
      .nameChat(ask.text, reply)
      .then(async (title) => {
        if (!title || title === provisional) return;
        const current = this.deps.chats.get(chat.id);
        if (!current || current.title !== provisional) return;
        await this.deps.chats.update(chat.id, (c) => (c.title === provisional ? { ...c, title } : c));
        this.announce(chat.id);
      })
      .catch(() => undefined);
    this.naming.add(naming);
    void naming.finally(() => this.naming.delete(naming));
  }

  /** Gives a chat the agent's title, unless the user renamed it from its first-message title meanwhile. */
  private async rename(chat: Chat, title: string): Promise<void> {
    const ask = chat.messages[0];
    if (!ask || ask.role !== "user") return;
    const provisional = provisionalTitle(ask.text);
    if (chat.title !== provisional || title === provisional) return;
    await this.deps.chats.update(chat.id, (c) => (c.title === provisional ? { ...c, title } : c));
    this.announce(chat.id);
  }

  /** Resolves once chats being named have their names, for tests and shutdown. */
  async named(): Promise<void> {
    await Promise.all([...this.naming]);
  }

  /** Tells every page an artifact changed (a new version or a new name), or is gone. */
  announceArtifact(record: ArtifactRecord): void {
    this.deps.emit({ type: "artifact.saved", chatId: record.chatId, artifact: this.artifactMeta(record) });
  }

  announceArtifactRemoved(chatId: string, artifactId: string): void {
    this.deps.emit({ type: "artifact.removed", chatId, artifactId });
  }

  /** Tells every page that a chat is gone. */
  announceRemoved(chatId: string): void {
    this.deps.emit({ type: "chat.removed", chatId });
  }

  /** Tells every page a chat's title, status or binding changed. */
  announce(chatId: string): void {
    const card = this.runs.get(chatId)?.pending?.card ?? this.held.get(chatId)?.card ?? null;
    this.deps.onStatus?.(chatId, this.status(chatId), card);
    const chat = this.deps.chats.get(chatId);
    if (chat) this.deps.emit({ type: "chat.updated", chat: this.summary(chat) });
  }
}

/** A tab as kept in chat history: the browser's target id is only good for this run. */
function withoutTarget(tab: TabInfo): TabInfo {
  const { targetId: _, ...rest } = tab;
  return rest;
}
