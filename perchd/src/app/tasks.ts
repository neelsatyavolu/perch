/**
 * Tasks for outside clients (`perch exec`, `perch session …`): each task is an ordinary Perch chat,
 * so it shows in Perch's chat list, its approvals reach the user as cards, and it can be resumed,
 * steered, queued and stopped like Aside's sessions. A client sees and controls only the tasks it
 * started, and a task never runs in a more permissive mode than its client has.
 */

import { raisesMode } from "../daemon/clients";
import type { App } from "./app";
import { AppError } from "./runs";
import { EFFORTS } from "./effort";
import type { Chat, ChatSettings, Effort, Mode, ModelInfo } from "./protocol";

export type TaskStatus = "running" | "waiting" | "done" | "failed" | "stopped";

export type TaskView = {
  id: string;
  title: string;
  status: TaskStatus;
  model: string;
  effort: Effort;
  mode: Mode;
  createdAt: string;
  updatedAt: string;
  /** The latest answer, or the text so far while it runs. */
  answer: string;
  /** What the current run has done, or the last run's steps. */
  steps: string[];
  /** What the task is waiting for the user to approve in Perch. */
  waitingFor: string | null;
  turns: number;
};

export type StartTask = { client: string; clientMode: Mode; task: string; model?: string; effort?: string; mode?: string };

const MODES: readonly Mode[] = ["ask", "guard", "skip"];
/** Queued follow-ups, per chat, run one after another once the chat is idle. */
const MAX_QUEUED = 10;

export class Tasks {
  private readonly queued = new Map<string, Promise<void>>();
  private readonly queueSize = new Map<string, number>();
  /** Bumped by stop and delete, so messages queued before them never run. */
  private readonly generation = new Map<string, number>();

  constructor(private readonly app: Pick<App, "chats" | "runs" | "info">) {}

  /** The models a task may use, as `perch exec --model` names them. */
  models(): ModelInfo[] {
    return this.app.info().models;
  }

  async start(input: StartTask): Promise<TaskView> {
    const defaults = this.app.info().defaults;
    const settings: ChatSettings = {
      ...defaults,
      model: input.model ? this.model(input.model).id : defaults.model,
      effort: input.effort ? effort(input.effort) : defaults.effort,
      mode: capped(input.mode ? mode(input.mode) : defaults.mode, input.clientMode),
      scope: "agent",
    };
    const chat = await this.app.chats.create({ settings, origin: input.client });
    await this.app.runs.send(chat.id, input.task);
    return this.view(this.app.chats.get(chat.id)!);
  }

  list(client: string): TaskView[] {
    return this.app.chats
      .list()
      .filter((c) => c.origin === client)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((c) => this.view(c));
  }

  get(client: string, id: string): TaskView {
    return this.view(this.own(client, id));
  }

  /** Resume: a follow-up in the same chat, with its history. */
  async send(client: string, id: string, text: string): Promise<TaskView> {
    const chat = this.own(client, id);
    if (this.app.runs.status(chat.id) !== "idle") throw new AppError("The task is still running. Use steer to interrupt it or queue to run this after it", 409);
    await this.app.runs.send(chat.id, text);
    return this.view(this.app.chats.get(chat.id)!);
  }

  /** Steer: stop the current step and continue with this message. */
  async steer(client: string, id: string, text: string): Promise<TaskView> {
    const chat = this.own(client, id);
    this.app.runs.cancel(chat.id);
    await this.app.runs.idleFor(chat.id);
    await this.app.runs.send(chat.id, text);
    return this.view(this.app.chats.get(chat.id)!);
  }

  /** Queue: send this once the current run, and anything queued before it, has finished. */
  queue(client: string, id: string, text: string): { queued: number } {
    const chat = this.own(client, id);
    const size = this.queueSize.get(chat.id) ?? 0;
    if (size >= MAX_QUEUED) throw new AppError(`At most ${MAX_QUEUED} messages can wait in one task`, 409);
    this.queueSize.set(chat.id, size + 1);
    const generation = this.generation.get(chat.id) ?? 0;
    const before = this.queued.get(chat.id) ?? Promise.resolve();
    const next = before
      .then(() => this.app.runs.idleFor(chat.id))
      .then(async () => {
        if (this.app.chats.get(chat.id) && (this.generation.get(chat.id) ?? 0) === generation) await this.app.runs.send(chat.id, text);
        await this.app.runs.idleFor(chat.id);
      })
      .catch(() => undefined)
      .finally(() => {
        const left = (this.queueSize.get(chat.id) ?? 1) - 1;
        if (left > 0) this.queueSize.set(chat.id, left);
        else this.queueSize.delete(chat.id);
        if (this.queued.get(chat.id) === next) this.queued.delete(chat.id);
      });
    this.queued.set(chat.id, next);
    return { queued: size + 1 };
  }

  /** Stops the run and drops anything queued after it. */
  stop(client: string, id: string): { stopped: boolean } {
    const chat = this.own(client, id);
    const dropped = (this.queueSize.get(chat.id) ?? 0) > 0;
    this.generation.set(chat.id, (this.generation.get(chat.id) ?? 0) + 1);
    return { stopped: this.app.runs.cancel(chat.id) || dropped };
  }

  async remove(client: string, id: string): Promise<{ removed: string }> {
    const chat = this.own(client, id);
    this.generation.set(chat.id, (this.generation.get(chat.id) ?? 0) + 1);
    this.app.runs.cancel(chat.id);
    await this.app.runs.idleFor(chat.id);
    await this.app.chats.remove(chat.id);
    this.app.runs.announceRemoved(chat.id);
    return { removed: chat.id };
  }

  /** A task by its id or a unique prefix of it (as `perch session list` prints them). */
  private own(client: string, id: string): Chat {
    const mine = this.app.chats.list().filter((c) => c.origin === client);
    const exact = mine.find((c) => c.id === id);
    if (exact) return exact;
    const matches = id.length >= 6 ? mine.filter((c) => c.id.startsWith(id)) : [];
    if (matches.length === 1) return matches[0]!;
    throw new AppError(matches.length > 1 ? `"${id}" matches more than one task; give more of its id` : `No task "${id}" started by ${client}`, 404);
  }

  private model(name: string): ModelInfo {
    const models = this.models();
    const wanted = name.trim().toLowerCase().replace("/", ":");
    // "openai/gpt-6.1-sol" and "gpt-6.1-sol" both name codex:gpt-6.1-sol.
    const bare = wanted.split(":").at(-1)!;
    const found =
      models.find((m) => m.id.toLowerCase() === wanted) ??
      unique(models.filter((m) => m.id.toLowerCase().split(":")[1] === bare)) ??
      unique(models.filter((m) => m.label.toLowerCase() === wanted)) ??
      unique(models.filter((m) => m.id.toLowerCase().includes(wanted) || m.label.toLowerCase().includes(wanted)));
    if (!found) throw new AppError(`Unknown model "${name}". Models: ${models.map((m) => m.id).join(", ")}`);
    return found;
  }

  private view(chat: Chat): TaskView {
    const live = this.app.runs.snapshot(chat.id);
    const status = this.app.runs.status(chat.id);
    const last = [...chat.messages].reverse().find((m) => m.role === "assistant");
    const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
    const answered = last && lastUser ? last.time >= lastUser.time : Boolean(last);
    return {
      id: chat.id,
      title: chat.title,
      status: status === "running" ? "running" : status === "waiting" ? "waiting" : !answered || last?.stopped ? "stopped" : last?.error ? "failed" : "done",
      model: chat.settings.model,
      effort: chat.settings.effort,
      mode: chat.settings.mode,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
      answer: live ? live.text : answered ? last!.text : "",
      steps: (live ? live.steps : answered ? last!.steps ?? [] : []).map((s) => s.label),
      waitingFor: live?.approval ? `${live.approval.title} on ${live.approval.site}` : null,
      turns: chat.messages.filter((m) => m.role === "user").length,
    };
  }
}

function unique<T>(list: T[]): T | undefined {
  return list.length === 1 ? list[0] : undefined;
}

function effort(value: string): Effort {
  const e = value.toLowerCase() as Effort;
  if (!EFFORTS.includes(e)) throw new AppError(`Effort must be one of ${EFFORTS.join(", ")}`);
  return e;
}

function mode(value: string): Mode {
  const m = (value.toLowerCase() === "full-access" ? "skip" : value.toLowerCase()) as Mode;
  if (!MODES.includes(m)) throw new AppError("Permission must be ask, guard or skip (full-access)");
  return m;
}

/** A task asks at least as often as its client is allowed to act without asking. */
function capped(wanted: Mode, client: Mode): Mode {
  if (raisesMode(client, wanted)) throw new AppError(`This client may use at most ${client} mode. Raise it with: perch clients mode <name> ${wanted}`, 403);
  return wanted;
}
