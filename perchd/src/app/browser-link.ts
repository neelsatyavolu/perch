/**
 * What ties the app to the browser that started perchd (plan 3b tasks 6 and 11): the perch dot
 * on the tabs each chat works in, Ask from the address bar and the new tab page, and approval
 * cards for outside agents that cannot ask the user themselves.
 *
 * The daemon and the app start before each other is ready, so the hooks here are bound late:
 * `onStatus` and `approvals` do nothing until `attach(app)`.
 */

import type { ApprovalRequest } from "../agent/session";
import type { PerchDomain } from "../browser/perch-domain";
import type { BrowserApprovals } from "../daemon/server";
import type { AgentSession } from "../daemon/sessions";
import type { App } from "./app";
import { askFromBrowser } from "./ask";
import { OutsideApprovals } from "./outside-approvals";
import type { ApprovalCard, ChatStatus } from "./protocol";
import { TaskStatusReporter } from "./task-status";

export type BrowserLinkOptions = {
  perch: PerchDomain;
  /** The agent tabs a sidebar chat's run works in now (its daemon sessions' tabs). */
  agentTabs: (chatId: string) => string[];
  onError?: (message: string) => void;
};

export class BrowserLink {
  private app: App | null = null;
  private reporter: TaskStatusReporter | null = null;
  private outside: OutsideApprovals | null = null;
  private stopAsk: (() => void) | null = null;

  constructor(private readonly opts: BrowserLinkOptions) {}

  /** RunManager's `onStatus` (AppOptions.onStatus). */
  readonly onStatus = (chatId: string, status: ChatStatus, card: ApprovalCard | null): void => {
    this.reporter?.update(chatId, status, card);
  };

  /** DaemonOptions.browser. */
  readonly approvals = (): BrowserApprovals | undefined => {
    const outside = this.outside;
    if (!outside) return undefined;
    return {
      approve: (session: AgentSession, request: ApprovalRequest, signal: AbortSignal) => outside.approve(session.label, request, () => session.tabIds(), signal),
      allowClient: (name: string, signal: AbortSignal) => outside.allowClient(name, signal),
    };
  };

  attach(app: App): void {
    this.app = app;
    const defaults = () => app.info().defaults;
    this.outside = new OutsideApprovals({ chats: app.chats, runs: app.runs, defaults, perch: this.opts.perch });
    this.reporter = new TaskStatusReporter({ perch: this.opts.perch, targets: (chatId) => this.targets(chatId) });
    this.stopAsk = this.opts.perch.onAskRequested((ask) => {
      void askFromBrowser({ chats: app.chats, runs: app.runs, tab: (id) => app.windows.tab(id), defaults, perch: this.opts.perch }, ask).catch((error: Error) =>
        this.opts.onError?.(`perchd: Ask from the browser failed: ${error.message}\n`),
      );
    });
  }

  /** A chat's own tab, the agent tabs of its run, and the tabs of an outside session it asks for. */
  targets(chatId: string): string[] {
    const app = this.app;
    if (!app) return [];
    const chat = app.chats.get(chatId);
    const own = chat?.tab ? app.windows.tab(chat.tab.id)?.targetId : undefined;
    return [...(own ? [own] : []), ...this.opts.agentTabs(chatId), ...(this.outside?.targets(chatId) ?? [])];
  }

  stop(): void {
    this.stopAsk?.();
    this.reporter?.stop();
  }
}
