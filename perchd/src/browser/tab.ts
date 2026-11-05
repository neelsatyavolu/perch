/** One page target, reached through a flattened CDP session. */

import type { CdpConnection } from "../cdp/connection";

export type WaitUntil = "load" | "networkidle";
const LIFECYCLE: Record<WaitUntil, string> = { load: "load", networkidle: "networkIdle" };
const NAV_TIMEOUT_MS = 30_000;

export class TabClosedError extends Error {
  constructor() {
    super("tab closed");
  }
}

export class Tab {
  private closedReject: ((error: Error) => void)[] = [];
  private isClosed = false;
  private readonly lifecycle: { loaderId: string; name: string }[] = [];

  private constructor(readonly conn: CdpConnection, readonly id: string, readonly session: string) {
    conn.on("Page.lifecycleEvent", (p: { loaderId: string; name: string; frameId: string }, sid) => {
      if (sid === session) this.lifecycle.push({ loaderId: p.loaderId, name: p.name });
    });
    const markClosed = () => {
      if (this.isClosed) return;
      this.isClosed = true;
      for (const reject of this.closedReject) reject(new TabClosedError());
    };
    conn.on("Target.detachedFromTarget", (p: { sessionId: string }) => p.sessionId === session && markClosed());
    conn.on("Target.targetDestroyed", (p: { targetId: string }) => p.targetId === id && markClosed());
  }

  static async attach(conn: CdpConnection, targetId: string): Promise<Tab> {
    const { sessionId } = await conn.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    const tab = new Tab(conn, targetId, sessionId);
    await Promise.all([
      tab.send("Page.enable"),
      tab.send("Runtime.enable"),
      tab.send("Page.setLifecycleEventsEnabled", { enabled: true }),
    ]);
    return tab;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /** Sends a CDP command on this tab's session; fails with "tab closed" once the tab is gone. */
  async send<T = any>(method: string, params: object = {}): Promise<T> {
    if (this.isClosed) throw new TabClosedError();
    try {
      return await this.whileOpen(this.conn.send<T>(method, params, this.session));
    } catch (error) {
      if (this.isClosed || /session|target closed|No target/i.test(String(error))) throw new TabClosedError();
      throw error;
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

  async close(): Promise<void> {
    if (this.isClosed) return;
    await this.conn.send("Target.closeTarget", { targetId: this.id }).catch(() => undefined);
  }
}
