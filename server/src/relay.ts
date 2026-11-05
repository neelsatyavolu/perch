import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, HonoEnv } from "./env";
import { HttpError } from "./http";
import { requireAuth } from "./auth/session";
import { limit, RULES } from "./ratelimit";

/**
 * The relay (spec 9.3): one Durable Object per account holds a WebSocket per online device and
 * forwards frames between them. Frames carry ciphertext the devices encrypted for each other; the
 * relay reads only the recipient id. Remote control and remote MCP both ride on it.
 */
export const relayRoutes = new Hono<HonoEnv>();

export const MAX_FRAME = 256 * 1024;
const WINDOW_MS = 10_000;
const FRAMES_PER_WINDOW = 200;
export const CLOSE_REPLACED = 4000;
export const CLOSE_REVOKED = 4001;
export const CLOSE_ABUSE = 4008;

relayRoutes.get("/", requireAuth, limit(RULES.relayConnect, (c) => c.var.auth.deviceId), async (c) => {
  if (c.req.header("upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "upgrade_required", "Connect to the relay with a WebSocket.");
  const { accountId, deviceId } = c.var.auth;
  const stub = c.env.RELAY.get(c.env.RELAY.idFromName(accountId));
  // A fresh request, so nothing the caller sent besides the upgrade reaches the room.
  return stub.fetch(new Request("https://relay.internal/connect", { headers: { Upgrade: "websocket", "X-Perch-Device": deviceId } }));
});

const frameSchema = z.object({ t: z.literal("msg"), to: z.string().regex(/^dev_[A-Za-z0-9_-]{22}$/), d: z.string().regex(/^[A-Za-z0-9_-]+$/) }).strict();
type Attachment = { deviceId: string; windowStart: number; count: number };

export class RelayRoom extends DurableObject<AppEnv> {
  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    // Answered without waking the object, so idle connections cost nothing.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  override async fetch(request: Request): Promise<Response> {
    const deviceId = request.headers.get("X-Perch-Device");
    if (!deviceId) return new Response("Missing device", { status: 400 });
    for (const old of this.ctx.getWebSockets(deviceId)) old.close(CLOSE_REPLACED, "Connected again from the same device");
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server, [deviceId]);
    server.serializeAttachment({ deviceId, windowStart: Date.now(), count: 0 } satisfies Attachment);
    this.sendPresence();
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const state = ws.deserializeAttachment() as Attachment;
    const now = Date.now();
    const fresh = now - state.windowStart > WINDOW_MS;
    const next = { ...state, windowStart: fresh ? now : state.windowStart, count: fresh ? 1 : state.count + 1 };
    ws.serializeAttachment(next);
    if (next.count > FRAMES_PER_WINDOW * 2) return ws.close(CLOSE_ABUSE, "Too many messages");
    if (next.count > FRAMES_PER_WINDOW) return this.error(ws, "rate_limited", "Too many messages. Slow down.");
    if (typeof message !== "string" || message.length > MAX_FRAME) return this.error(ws, "bad_frame", "Frames are JSON text up to 256 KB.");
    let frame: z.infer<typeof frameSchema>;
    try {
      frame = frameSchema.parse(JSON.parse(message));
    } catch {
      return this.error(ws, "bad_frame", "That frame is not a relay message.");
    }
    const targets = frame.to === state.deviceId ? [] : this.ctx.getWebSockets(frame.to);
    if (!targets.length) return this.error(ws, "offline", "That device is not connected.", frame.to);
    const out = JSON.stringify({ t: "msg", from: state.deviceId, d: frame.d });
    for (const target of targets) target.send(out);
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try {
      ws.close(code === 1005 ? 1000 : code, "Closed");
    } catch {
      // Already closed.
    }
    this.sendPresence(ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.sendPresence(ws);
  }

  /** Closes a revoked device's connection. */
  disconnect(deviceId: string): void {
    for (const ws of this.ctx.getWebSockets(deviceId)) ws.close(CLOSE_REVOKED, "This device was removed from the account");
    this.sendPresence();
  }

  /** Closes every connection, when the account is deleted. */
  disconnectAll(): void {
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_REVOKED, "The account was deleted");
  }

  private error(ws: WebSocket, code: string, message: string, to?: string): void {
    ws.send(JSON.stringify({ t: "error", code, message, ...(to ? { to } : {}) }));
  }

  /** Tells every device which devices are online. */
  private sendPresence(leaving?: WebSocket): void {
    const sockets = this.ctx.getWebSockets().filter((ws) => ws !== leaving && ws.readyState === WebSocket.OPEN);
    const online = [...new Set(sockets.map((ws) => (ws.deserializeAttachment() as Attachment).deviceId))];
    const message = JSON.stringify({ t: "presence", online });
    for (const ws of sockets) ws.send(message);
  }
}
