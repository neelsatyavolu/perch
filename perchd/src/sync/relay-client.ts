/**
 * The relay client: one WebSocket to the account's relay room, an encrypted channel per trusted
 * peer, and typed messages on top. Remote control (`perch exec --host`) and remote MCP both use
 * it: MCP messages travel as `{ kind: "mcp", body: <JSON-RPC message> }`. Messages from devices
 * this device has not paired with are dropped, whatever the server says. Before the first message
 * to a peer the two sides exchange hellos (channel.ts), so every message names the receiver's
 * current session. A message sent at the moment the other side restarts is dropped there; the
 * sender learns the new session from the answer, and callers such as remote MCP retry.
 */
import { PeerChannel, type Me, type Peer } from "./channel";

export const DEFAULT_RELAY = "wss://relay.perchbrowser.com/v1/relay";

export type RelayMessage = { kind: string; body: unknown };
export type SocketLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: any) => void): void;
};
export type Connect = (url: string, token: string) => SocketLike;

/** Bun's WebSocket takes headers, so the token is never put in the URL. */
export const bunConnect: Connect = (url, token) =>
  new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as unknown as string[]) as unknown as SocketLike;

type Handlers = {
  message: (from: string, message: RelayMessage) => void;
  presence: (online: string[]) => void;
  error: (code: string, message: string) => void;
  close: (code: number) => void;
};

type Waiter = { resolve: () => void; reject: (error: Error) => void };
const HANDSHAKE_MS = 10_000;

export class RelayClient {
  private socket: SocketLike | undefined;
  private readonly channels = new Map<string, Promise<PeerChannel>>();
  private handlers: Partial<Handlers> = {};
  /** Frames are opened one at a time, in arrival order, so the replay check sees them in order. */
  private inbox: Promise<void> = Promise.resolve();
  /** Sends waiting for a peer's hello, by peer id. */
  private waiting = new Map<string, Waiter[]>();

  constructor(private readonly options: { url?: string; token: string; me: Me; trusted: Peer[]; connect?: Connect; handshakeMs?: number }) {}

  on<K extends keyof Handlers>(event: K, handler: Handlers[K]): void {
    this.handlers = { ...this.handlers, [event]: handler };
  }

  connect(): Promise<void> {
    const socket = (this.options.connect ?? bunConnect)(this.options.url ?? DEFAULT_RELAY, this.options.token);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      this.inbox = this.inbox.then(() => this.receive(String(event.data)));
    });
    socket.addEventListener("close", (event) => this.handlers.close?.(event.code));
    return new Promise((resolve, reject) => {
      socket.addEventListener("open", () => resolve());
      socket.addEventListener("error", () => reject(new Error("Could not reach the relay.")));
    });
  }

  private channel(peerId: string): Promise<PeerChannel> {
    const peer = this.options.trusted.find((p) => p.id === peerId);
    if (!peer) return Promise.reject(new Error("That device is not paired with this one."));
    let channel = this.channels.get(peerId);
    if (!channel) {
      channel = PeerChannel.open(this.options.me, peer);
      this.channels.set(peerId, channel);
    }
    return channel;
  }

  async send(peerId: string, message: RelayMessage): Promise<void> {
    if (!this.socket) throw new Error("Not connected to the relay.");
    const channel = await this.channel(peerId);
    if (!channel.ready) await this.handshake(peerId, channel);
    this.frame(peerId, await channel.seal(message));
  }

  private frame(peerId: string, d: string): void {
    if (!this.socket) throw new Error("Not connected to the relay.");
    this.socket.send(JSON.stringify({ t: "msg", to: peerId, d }));
  }

  /** Sends a hello and waits for the peer's, so the first message is bound to its current session. */
  private handshake(peerId: string, channel: PeerChannel): Promise<void> {
    const answered = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(peerId, new Error("That device did not answer. Check that Perch is running on it.")), this.options.handshakeMs ?? HANDSHAKE_MS);
      const waiter: Waiter = {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (error) => (clearTimeout(timer), reject(error)),
      };
      this.waiting = new Map(this.waiting).set(peerId, [...(this.waiting.get(peerId) ?? []), waiter]);
    });
    return channel.hello().then((d) => this.frame(peerId, d)).then(() => answered);
  }

  /** Resolves (or, with an error, rejects) every send waiting on a peer. */
  private settle(peerId: string, error?: Error): void {
    const waiters = this.waiting.get(peerId) ?? [];
    const next = new Map(this.waiting);
    next.delete(peerId);
    this.waiting = next;
    for (const waiter of waiters) (error ? waiter.reject(error) : waiter.resolve());
  }

  private async receive(raw: string): Promise<void> {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame?.t === "presence" && Array.isArray(frame.online)) return this.handlers.presence?.(frame.online.filter((id: unknown) => typeof id === "string"));
    if (frame?.t === "error") {
      if (frame.code === "offline" && typeof frame.to === "string") this.settle(frame.to, new Error("That device is not connected to the relay."));
      return this.handlers.error?.(String(frame.code), String(frame.message));
    }
    if (frame?.t !== "msg" || typeof frame.from !== "string" || typeof frame.d !== "string") return;
    if (!this.options.trusted.some((p) => p.id === frame.from)) return;
    try {
      const channel = await this.channel(frame.from);
      const opened = await channel.open(frame.d);
      this.settle(frame.from);
      // The peer does not know this session yet (first contact, or this device restarted): tell it.
      if (!opened.message) return opened.answer ? this.frame(frame.from, await channel.hello()) : undefined;
      const value = opened.value as RelayMessage;
      if (value && typeof value.kind === "string") this.handlers.message?.(frame.from, value);
    } catch {
      this.handlers.error?.("bad_frame", "A relay message could not be opened and was dropped.");
    }
  }

  close(): void {
    this.socket?.close(1000, "Closed");
    this.socket = undefined;
  }
}

/**
 * Serves MCP to paired remote devices: each incoming `mcp` message goes to `handle` with the
 * sender's device id (so Perch applies that device's permission mode), and any reply goes back.
 */
export function serveRemoteMcp(relay: RelayClient, handle: (from: string, body: unknown) => Promise<unknown | null>): void {
  relay.on("message", (from, message) => {
    if (message.kind !== "mcp") return;
    void handle(from, message.body)
      .then((reply) => (reply == null ? undefined : relay.send(from, { kind: "mcp", body: reply })))
      .catch(() => relay.send(from, { kind: "mcp-error", body: { message: "Perch could not handle that request." } }).catch(() => undefined));
  });
}
