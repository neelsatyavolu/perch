/**
 * Runs: one agent task per chat at a time. A run streams its events to every open page, waits
 * for the user at approvals, stops on cancel, and keeps going when no page is watching (a side
 * chat's task continues while its tab is in the background, spec 5.3).
 */

import type { StepEvent } from "../agent/loop";
import type { ApprovalRequest } from "../agent/session";
import { describeApproval } from "./approval-card";
import { parseArtifactBlocks, type ArtifactRecord, type ArtifactStore } from "./artifacts";
import type { ChatStore } from "./chats";
import type { AppEvent, ApprovalCard, ArtifactMeta, Chat, ChatMessage, ChatSettings, ChatStatus, ChatSummary, RunSnapshot, TabInfo } from "./protocol";
import { buildTask } from "./transcript";

export type RunnerInput = { task: string; settings: ChatSettings; approve: (req: ApprovalRequest) => Promise<boolean>; signal: AbortSignal };
export type Runner = (input: RunnerInput) => AsyncIterable<StepEvent>;

export type RunDeps = {
  chats: ChatStore;
  artifacts: ArtifactStore;
  runner: Runner;
  emit: (event: AppEvent) => void;
  artifactUrl: (id: string, version: number) => string;
  /** The tabs the browser reported, for the "all tabs" scope. */
  tabs: () => TabInfo[];
};

export class AppError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type Pending = { card: ApprovalCard; resolve: (approved: boolean) => void };
type Run = { runId: string; chatId: string; controller: AbortController; text: string; steps: string[]; pending: Pending | null; done: Promise<void> };

const MAX_MESSAGE = 50_000;

export class RunManager {
  private runs = new Map<string, Run>();

  constructor(private readonly deps: RunDeps) {}

  status(chatId: string): ChatStatus {
    const run = this.runs.get(chatId);
    return !run ? "idle" : run.pending ? "waiting" : "running";
  }

  snapshot(chatId: string): RunSnapshot | null {
    const run = this.runs.get(chatId);
    return run ? { runId: run.runId, chatId, text: run.text, steps: run.steps, approval: run.pending?.card ?? null } : null;
  }

  summary(chat: Chat): ChatSummary {
    const last = chat.messages.at(-1);
    return { id: chat.id, title: chat.title, updatedAt: chat.updatedAt, tab: chat.tab, status: this.status(chat.id), preview: (last?.text ?? "").replace(/\[\[artifact:[^\]]+\]\]/g, "").replace(/\s+/g, " ").trim().slice(0, 140) };
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

  async send(chatId: string, text: string, context?: TabInfo): Promise<{ runId: string; message: ChatMessage }> {
    const chat = this.deps.chats.get(chatId);
    if (!chat) throw new AppError(`no chat ${chatId}`, 404);
    if (!text.trim()) throw new AppError("The message is empty");
    if (text.length > MAX_MESSAGE) throw new AppError("The message is too long (50,000 characters at most)");
    if (this.runs.has(chatId)) throw new AppError("A task is still running in this chat. Wait for it or stop it first", 409);
    const message: ChatMessage = { id: crypto.randomUUID(), role: "user", text, time: new Date().toISOString(), ...(context ? { context } : {}) };
    const task = buildTask({ history: chat.messages, text, scope: chat.settings.scope, tab: context, tabs: this.deps.tabs() });
    const run: Run = { runId: crypto.randomUUID(), chatId, controller: new AbortController(), text: "", steps: [], pending: null, done: Promise.resolve() };
    this.runs.set(chatId, run);
    try {
      const updated = await this.deps.chats.update(chatId, (c) => ({
        ...c,
        title: c.title === "New chat" && c.messages.length === 0 ? titleFrom(text) : c.title,
        draft: "",
        messages: [...c.messages, message],
      }));
      this.deps.emit({ type: "run.started", chatId, runId: run.runId, message });
      this.deps.emit({ type: "chat.updated", chat: this.summary(updated) });
    } catch (error) {
      this.runs.delete(chatId);
      throw error;
    }
    run.done = this.drive(run, task, chat.settings);
    return { runId: run.runId, message };
  }

  /** The user's answer to an approval card. False when the card is not waiting any more. */
  decide(approvalId: string, approved: boolean): boolean {
    const run = [...this.runs.values()].find((r) => r.pending?.card.id === approvalId);
    if (!run?.pending) return false;
    run.pending.resolve(approved);
    return true;
  }

  cancel(chatId: string): boolean {
    const run = this.runs.get(chatId);
    if (!run || run.controller.signal.aborted) return false;
    run.controller.abort();
    run.pending?.resolve(false);
    return true;
  }

  /** Resolves when every run that is going now has finished. */
  async idle(): Promise<void> {
    while (this.runs.size) await Promise.all([...this.runs.values()].map((r) => r.done));
  }

  private approve(run: Run) {
    return (request: ApprovalRequest): Promise<boolean> => {
      if (run.controller.signal.aborted) return Promise.resolve(false);
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

  private async drive(run: Run, task: string, settings: ChatSettings): Promise<void> {
    let final: string | undefined;
    let error: string | undefined;
    try {
      const events = this.deps.runner({ task, settings, approve: this.approve(run), signal: run.controller.signal });
      for await (const event of events) {
        if (event.type === "text") {
          run.text += event.delta;
          if (event.delta) this.deps.emit({ type: "run.text", chatId: run.chatId, runId: run.runId, delta: event.delta });
        } else if (event.type === "step") {
          run.steps = [...run.steps, event.label];
          this.deps.emit({ type: "run.step", chatId: run.chatId, runId: run.runId, label: event.label });
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
    }
  }

  private async finish(run: Run, final: string | undefined, error: string | undefined): Promise<void> {
    const stopped = run.controller.signal.aborted;
    const parsed = parseArtifactBlocks(final ?? run.text.trim());
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
    await this.deps.chats.update(run.chatId, (c) => ({ ...c, messages: [...c.messages, message] }));
    this.deps.emit({ type: "run.finished", chatId: run.chatId, runId: run.runId, message });
  }

  /** Tells every page that a chat is gone. */
  announceRemoved(chatId: string): void {
    this.deps.emit({ type: "chat.removed", chatId });
  }

  /** Tells every page a chat's title, status or binding changed. */
  announce(chatId: string): void {
    const chat = this.deps.chats.get(chatId);
    if (chat) this.deps.emit({ type: "chat.updated", chat: this.summary(chat) });
  }
}

function titleFrom(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= 60 ? line : `${line.slice(0, 59).trimEnd()}…`;
}
