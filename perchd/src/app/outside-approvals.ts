/**
 * Approvals for outside agents inside Perch (plan 3b task 11). A client without its own prompt
 * (Codex has no MCP elicitation) used to get every risky action declined. Inside Perch the card
 * goes to a chat named after the agent's session ("Codex · perch") instead, the browser brings
 * that chat forward, and the agent's tabs show the waiting dot until the user answers.
 *
 * A client's first connection asks the same way: "Allow Codex to use Perch in Guard mode".
 */

import type { ApprovalRequest } from "../agent/session";
import type { PerchDomainApi } from "../browser/perch-domain";
import { describeApproval } from "./approval-card";
import type { ChatStore } from "./chats";
import type { ApprovalCard, ChatSettings } from "./protocol";
import type { RunManager } from "./runs";

export type OutsideDeps = {
  chats: ChatStore;
  runs: RunManager;
  defaults: () => ChatSettings;
  perch: Pick<PerchDomainApi, "revealChat">;
};

type CardText = Omit<ApprovalCard, "id" | "chatId" | "runId">;

export class OutsideApprovals {
  /** Chat ids by session label, and the tabs each chat's session works in. */
  private readonly chatOf = new Map<string, string>();
  private readonly tabsOf = new Map<string, () => string[]>();

  constructor(private readonly deps: OutsideDeps) {}

  /** An outside session's action that needs the user. `tabs` are the session's tabs, for the dot. */
  async approve(label: string, request: ApprovalRequest, tabs: () => string[] = () => [], signal?: AbortSignal): Promise<boolean> {
    const { id: _, chatId: __, runId: ___, ...card } = describeApproval(request, { id: "", chatId: "", runId: "" });
    return this.ask(label, card, tabs, signal);
  }

  /** A client's first connection. Declining leaves it unregistered; it can ask again next time. */
  allowClient(name: string, signal?: AbortSignal): Promise<boolean> {
    return this.ask(`New agent · ${name}`, {
      title: `Allow ${name} to use Perch in Guard mode`,
      site: "",
      kind: "change",
      body: `${name} asked to use this browser. It can open tabs, read pages and act in them. In Guard mode Perch asks you before it sends, buys or deletes anything. You can change this in Settings, Permissions.`,
      confirm: `Allow ${name}`,
      danger: false,
    }, () => [], signal);
  }

  /**
   * A step an outside session took: it shows in the session's chat (made on its first step, named
   * after the session), so clicking one of its agent tabs opens a chat with what it has done.
   */
  async observe(label: string, tabs: () => string[], step: { label: string; detail?: string }): Promise<void> {
    const chatId = await this.chatFor(label);
    this.tabsOf.set(chatId, tabs);
    this.deps.runs.observeStep(chatId, `${label} is working in Perch`, step);
  }

  /** The tabs a chat's outside session works in (TaskStatusReporter's targets). */
  targets(chatId: string): string[] {
    return this.tabsOf.get(chatId)?.() ?? [];
  }

  private async ask(label: string, card: CardText, tabs: () => string[], signal?: AbortSignal): Promise<boolean> {
    const chatId = await this.chatFor(label);
    this.tabsOf.set(chatId, tabs);
    const answer = this.deps.runs.hold(chatId, card, signal);
    await this.deps.perch.revealChat({ chatId, mode: "full" }).catch(() => null);
    return answer;
  }

  private async chatFor(label: string): Promise<string> {
    const known = this.chatOf.get(label);
    if (known && this.deps.chats.get(known)) return known;
    const chat = await this.deps.chats.create({ title: label, settings: this.deps.defaults() });
    this.chatOf.set(label, chat.id);
    return chat.id;
  }
}
