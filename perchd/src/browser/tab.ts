/** One page target, reached through a flattened CDP session. */

import type { CdpConnection } from "../cdp/connection";

export type WaitUntil = "load" | "networkidle";
const LIFECYCLE: Record<WaitUntil, string> = { load: "load", networkidle: "networkIdle" };
const NAV_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;
const SETTLE_LIMIT_MS = 10_000;

export class TabClosedError extends Error {
  constructor() {
    super("tab closed");
  }
}

export const STOPPED_RESPONDING = "the page stopped responding";

export class PageTimeoutError extends Error {
  constructor() {
    super(STOPPED_RESPONDING);
  }
}

export class Tab {
  /** Perch's own scratch tabs (the REPL sandbox), left out of tab lists. */
  static readonly hidden = new Set<string>();
  /** How long one CDP command may take before the page counts as frozen. */
  timeoutMs = COMMAND_TIMEOUT_MS;
  private closedReject: ((error: Error) => void)[] = [];
  private isClosed = false;
  private readonly lifecycle: { loaderId: string; name: string }[] = [];
  private dialogNotes: string[] = [];
  private pageErrors: string[] = [];
  private mainFrameId = "";
  private navigationPending = false;
  private readonly unsubscribe: (() => void)[] = [];
  private loading = false;
  /** Cross-site iframes run in their own process and session: frame id → session id. */
  readonly frameSessions = new Map<string, string>();

  private constructor(readonly conn: CdpConnection, readonly id: string, readonly session: string) {
    const listen = (event: string, listener: Parameters<CdpConnection["on"]>[1]) => this.unsubscribe.push(conn.on(event, listener));
    listen("Page.lifecycleEvent", (p: { loaderId: string; name: string; frameId: string }, sid) => {
      if (sid === session) this.lifecycle.push({ loaderId: p.loaderId, name: p.name });
    });
    // Dialogs block the page until answered, so answer at once and tell the model what happened.
    listen("Page.javascriptDialogOpening", (p: { type: string; message: string }, sid) => {
      if (sid !== session) return;
      const accept = p.type === "alert" || p.type === "beforeunload";
      const kind = p.type === "alert" ? "an alert" : p.type === "beforeunload" ? "a leave-page prompt" : `a ${p.type} dialog`;
      this.dialogNotes.push(`The page showed ${kind}: "${p.message}". Perch ${accept ? "closed" : "dismissed"} it.`);
      void conn.send("Page.handleJavaScriptDialog", { accept }, session).catch(() => undefined);
    });
    // Uncaught errors in the page's own script: a button whose handler throws does nothing visible.
    listen("Runtime.exceptionThrown", (p: { exceptionDetails: { text: string; exception?: { description?: string } } }, sid) => {
      if (sid !== session || this.pageErrors.length >= 3) return;
      const d = p.exceptionDetails;
      this.pageErrors.push((d.exception?.description ?? d.text).split("\n")[0]!.slice(0, 200));
    });
    listen("Target.attachedToTarget", (p: { sessionId: string; targetInfo: { targetId: string; type: string } }, sid) => {
      if (sid === session && p.targetInfo.type === "iframe") this.frameSessions.set(p.targetInfo.targetId, p.sessionId);
    });
    listen("Target.detachedFromTarget", (p: { sessionId: string; targetId?: string }, sid) => {
      if (sid !== session) return;
      for (const [frameId, child] of this.frameSessions) if (child === p.sessionId) this.frameSessions.delete(frameId);
    });
    const main = (frameId: string) => frameId === this.mainFrameId;
    listen("Page.frameRequestedNavigation", (p: { frameId: string }, sid) => {
      if (sid === session && main(p.frameId)) this.navigationPending = true;
    });
    listen("Page.frameStartedLoading", (p: { frameId: string }, sid) => {
      if (sid === session && main(p.frameId)) [this.loading, this.navigationPending] = [true, false];
    });
    listen("Page.frameStoppedLoading", (p: { frameId: string }, sid) => {
      if (sid === session && main(p.frameId)) [this.loading, this.navigationPending] = [false, false];
    });
    const markClosed = () => {
      if (this.isClosed) return;
      this.isClosed = true;
      for (const reject of this.closedReject) reject(new TabClosedError());
    };
    listen("Target.detachedFromTarget", (p: { sessionId: string }) => p.sessionId === session && markClosed());
    listen("Target.targetDestroyed", (p: { targetId: string }) => p.targetId === id && markClosed());
  }

  static async attach(conn: CdpConnection, targetId: string): Promise<Tab> {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(conn, targetId, sessionId);
    await Promise.all([
      tab.send("Page.enable"),
      tab.send("Runtime.enable"),
      tab.send("Page.setLifecycleEventsEnabled", { enabled: true }),
    ]);
    const { frameTree } = await tab.send<{ frameTree: { frame: { id: string } } }>("Page.getFrameTree");
    tab.mainFrameId = frameTree.frame.id;
    // Cross-site iframes get their own sessions, so their content can be read and acted on.
    await tab.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    return tab;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Sends a CDP command on this tab's session. Fails with "tab closed" once the tab is gone, and
   * with "the page stopped responding" when it takes longer than timeoutMs.
   */
  async send<T = any>(method: string, params: object = {}): Promise<T> {
    return this.sendIn<T>(undefined, method, params);
  }

  /** Like send, on a cross-site iframe's session when one is given. */
  async sendIn<T = any>(frameSession: string | undefined, method: string, params: object = {}): Promise<T> {
    if (this.isClosed) throw new TabClosedError();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PageTimeoutError()), this.timeoutMs);
    });
    try {
      return await Promise.race([this.whileOpen(this.conn.send<T>(method, params, frameSession ?? this.session)), timeout]);
    } catch (error) {
      if (error instanceof PageTimeoutError) throw error;
      if (this.isClosed || /session|target closed|No target/i.test(String(error))) throw new TabClosedError();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Notes about dialogs the page showed since the last call; each note is returned once. */
  takeDialogNotes(): string[] {
    const notes = this.dialogNotes;
    this.dialogNotes = [];
    return notes;
  }

  /** Uncaught script errors the page raised since the last call; each is returned once. */
  takePageErrors(): string[] {
    const errors = this.pageErrors;
    this.pageErrors = [];
    return errors;
  }

  /** After an action: waits for any navigation it started to finish loading, up to 10 s. */
  async settle(): Promise<void> {
    await Bun.sleep(150);
    const started = Date.now();
    while ((this.navigationPending || this.loading) && Date.now() - started < SETTLE_LIMIT_MS && !this.isClosed) await Bun.sleep(50);
    while (Date.now() - started < SETTLE_LIMIT_MS) {
      const state = await this.evaluate<string>("document.readyState").catch(() => "loading");
      if (state === "complete" || this.isClosed) return;
      await Bun.sleep(100);
    }
  }

  /** Races a promise against this tab closing. */
  whileOpen<T>(promise: Promise<T>): Promise<T> {
    if (this.isClosed) return Promise.reject(new TabClosedError());
    return new Promise<T>((resolve, reject) => {
      const onClose = (error: Error) => reject(error);
      this.closedReject.push(onClose);
      promise.then(resolve, reject).finally(() => {
        this.closedReject = this.closedReject.filter((fn) => fn !== onClose);
      });
    });
  }

  async navigate(url: string, opts: { waitUntil?: WaitUntil; timeoutMs?: number } = {}): Promise<void> {
    const want = LIFECYCLE[opts.waitUntil ?? "load"];
    const result = await this.send<{ loaderId?: string; errorText?: string }>("Page.navigate", { url });
    if (result.errorText) throw new Error(`navigation to ${url} failed: ${result.errorText}`);
    if (!result.loaderId) return;
    await this.waitForLifecycle(result.loaderId, want, opts.timeoutMs ?? NAV_TIMEOUT_MS);
  }

  private waitForLifecycle(loaderId: string, name: string, timeoutMs: number): Promise<void> {
    const seen = () => this.lifecycle.some((e) => e.loaderId === loaderId && e.name === name);
    return this.whileOpen(
      new Promise<void>((resolve, reject) => {
        const started = Date.now();
        const tick = () => {
          if (seen()) return resolve();
          if (this.isClosed) return reject(new TabClosedError());
          if (Date.now() - started > timeoutMs) return reject(new Error(`page did not finish loading in ${timeoutMs / 1000}s`));
          setTimeout(tick, 25);
        };
        tick();
      }),
    );
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
    );
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value as T;
  }

  url(): Promise<string> {
    return this.evaluate<string>("location.href");
  }

  title(): Promise<string> {
    return this.evaluate<string>("document.title");
  }

  /**
   * Lets go of a tab without closing it: a user's tab an agent borrowed. Perch stops listening to
   * it, so it no longer answers the page's dialogs.
   */
  async detach(): Promise<void> {
    for (const off of this.unsubscribe.splice(0)) off();
    if (this.isClosed) return;
    this.isClosed = true;
    await this.conn.send("Target.detachFromTarget", { sessionId: this.session }).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.isClosed) return;
    await this.conn.send("Target.closeTarget", { targetId: this.id }).catch(() => undefined);
  }
}
