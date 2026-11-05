/** A Chrome DevTools Protocol connection: request/response by id, events by name. */

type Listener = (params: any, sessionId?: string) => void;

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; method: string };

export class CdpError extends Error {
  constructor(method: string, message: string, readonly code?: number) {
    super(`${method}: ${message}`);
  }
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private closedError: Error | null = null;
  /** The browser's process id, when launched by us. */
  pid?: number;
  private resolveClosed!: (error: Error | null) => void;
  readonly closed: Promise<Error | null> = new Promise((resolve) => (this.resolveClosed = resolve));

  constructor(
    private readonly write: (message: object) => void,
    private readonly shutdown: () => Promise<void>,
  ) {}

  send<T = any>(method: string, params: object = {}, sessionId?: string): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method, params };
    if (sessionId) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      try {
        this.write(message);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(event: string, listener: Listener): () => void {
    let set = this.listeners.get(event);
    if (!set) this.listeners.set(event, (set = new Set()));
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Called by the transport for every decoded message. */
  handle(message: any): void {
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new CdpError(pending.method, message.error.message, message.error.code));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
    }
  }

  /** Called by the transport when the browser goes away. */
  fail(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.resolveClosed(error);
  }

  async close(): Promise<void> {
    if (this.closedError) return;
    await this.shutdown();
    this.fail(new Error("browser closed"));
  }
}
