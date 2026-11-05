/** A connection to perchd's socket, used by the `perch` command and `perch mcp`. */

import type { ApproveAsk, Fatal, Hello, Response, Welcome } from "../daemon/protocol";
import { LineReader, SocketWriter } from "../daemon/wire";

export class DaemonNotRunning extends Error {
  constructor() {
    super("perchd is not running");
  }
}

export type ConnectOptions = {
  socket: string;
  hello: Omit<Hello, "type" | "interactive">;
  /** Answers the daemon's approval requests; without it, the connection says it cannot. */
  onApprove?: (ask: ApproveAsk) => Promise<boolean>;
  /** Called once when the socket closes. */
  onClose?: () => void;
};

export type DaemonClient = {
  welcome: Welcome;
  request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
};

export async function connect(opts: ConnectOptions): Promise<DaemonClient> {
  const reader = new LineReader();
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let writer!: SocketWriter;
  let nextId = 1;
  let closed = false;
  let welcomed!: (w: Welcome) => void;
  let refused!: (e: Error) => void;
  const welcome = new Promise<Welcome>((resolve, reject) => ((welcomed = resolve), (refused = reject)));

  const shutdown = (error: Error) => {
    if (closed) return;
    closed = true;
    refused(error);
    for (const w of waiting.values()) w.reject(error);
    waiting.clear();
    opts.onClose?.();
  };

  const onMessage = (msg: Welcome | Response | ApproveAsk | Fatal) => {
    if (msg.type === "welcome") return welcomed(msg);
    if (msg.type === "error") return shutdown(new Error(msg.error));
    if (msg.type === "approve") {
      const answer = opts.onApprove ? opts.onApprove(msg) : Promise.resolve(false);
      void answer.catch(() => false).then((approved) => writer.send({ type: "approval", id: msg.id, approved }));
      return;
    }
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error !== undefined) w.reject(new Error(msg.error));
    else w.resolve(msg.result);
  };

  let socket;
  try {
    socket = await Bun.connect({
      unix: opts.socket,
      socket: {
        data(_s, chunk) {
          try {
            for (const line of reader.push(chunk)) onMessage(JSON.parse(line));
          } catch (error) {
            shutdown(error as Error);
          }
        },
        drain() {
          writer.flush();
        },
        close() {
          shutdown(new Error("perchd closed the connection"));
        },
        error(_s, error) {
          shutdown(error);
        },
      },
    });
  } catch {
    throw new DaemonNotRunning();
  }
  writer = new SocketWriter(socket);
  writer.send({ type: "hello", ...opts.hello, interactive: Boolean(opts.onApprove) });
  const w = await welcome;
  return {
    welcome: w,
    request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) return Promise.reject(new Error("perchd closed the connection"));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
        writer.send({ type: "request", id, method, params });
      });
    },
    close() {
      writer.end();
    },
  };
}
