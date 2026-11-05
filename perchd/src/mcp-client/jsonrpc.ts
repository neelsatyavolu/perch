/**
 * JSON-RPC 2.0 over any MCP transport: request ids, timeouts, cancellation, and the few requests
 * a server may send the client. Perch declares no client capabilities, so it answers ping and
 * declines everything else.
 */

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export interface Transport {
  /** Starts delivering messages. onClose fires once, when the connection ends for any reason. */
  start(onMessage: (msg: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void>;
  send(msg: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  /** HTTP transports send the negotiated version on every request after initialize. */
  setProtocolVersion?(version: string): void;
}

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export type RequestOptions = { timeoutMs?: number; signal?: AbortSignal };

const DEFAULT_TIMEOUT_MS = 60_000;

export class RpcSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closedError: Error | null = null;
  private readonly notificationHandlers: ((method: string, params: unknown) => void)[] = [];
  private readonly closeHandlers: ((error?: Error) => void)[] = [];

  constructor(private readonly transport: Transport) {}

  async start(): Promise<void> {
    await this.transport.start(
      (msg) => this.receive(msg),
      (error) => this.closed(error ?? new Error("the server closed the connection")),
    );
  }

  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandlers.push(handler);
  }

  onClose(handler: (error?: Error) => void): void {
    this.closeHandlers.push(handler);
  }

  get isClosed(): boolean {
    return this.closedError !== null;
  }

  request<T>(method: string, params?: unknown, opts: RequestOptions = {}): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    if (opts.signal?.aborted) return Promise.reject(new Error("Cancelled."));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const cancel = (reason: string) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        void this.transport.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason } }).catch(() => undefined);
        reject(new Error(reason));
      };
      const timer = setTimeout(() => cancel(`The server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`), timeoutMs);
      opts.signal?.addEventListener("abort", () => cancel("Cancelled."), { once: true });
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.transport.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }).catch((error: Error) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  notify(method: string, params?: unknown): Promise<void> {
    return this.transport.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  async close(): Promise<void> {
    this.closed(new Error("The connection was closed."));
    await this.transport.close().catch(() => undefined);
  }

  private receive(msg: JsonRpcMessage): void {
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;
    if (msg.method && msg.id !== undefined && msg.id !== null) return void this.answerServerRequest(msg);
    if (msg.method) {
      for (const h of this.notificationHandlers) h(msg.method, msg.params);
      return;
    }
    const pending = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!pending) return;
    this.pending.delete(msg.id as number);
    clearTimeout(pending.timer);
    if (msg.error) pending.reject(new RpcError(String(msg.error.message ?? "error").slice(0, 2000), Number(msg.error.code ?? -32603)));
    else pending.resolve(msg.result);
  }

  private async answerServerRequest(msg: JsonRpcMessage): Promise<void> {
    const reply: JsonRpcMessage =
      msg.method === "ping"
        ? { jsonrpc: "2.0", id: msg.id, result: {} }
        : { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Perch does not support ${msg.method}` } };
    await this.transport.send(reply).catch(() => undefined);
  }

  private closed(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    for (const h of this.closeHandlers) h(error);
  }
}
