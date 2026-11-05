/**
 * The Streamable HTTP transport (MCP 2025-03-26 and later): each message is a POST; the answer is
 * JSON or an event stream. When a server rejects the POST that starts a session (400, 404, 405),
 * connectRemote falls back to the older HTTP+SSE transport.
 */

import { McpClient } from "./client";
import type { JsonRpcMessage, Transport } from "./jsonrpc";
import { authHeaders, deliverSse, HttpStatusError, SseTransport, statusError, type HttpOptions } from "./sse";

const FALLBACK_STATUSES = new Set([400, 404, 405]);

export class StreamableHttpTransport implements Transport {
  private readonly controller = new AbortController();
  private sessionId: string | null = null;
  private protocolVersion: string | null = null;
  private onMessage: (msg: JsonRpcMessage) => void = () => undefined;
  private onClose: (error?: Error) => void = () => undefined;
  private closed = false;

  constructor(private readonly opts: HttpOptions) {}

  async start(onMessage: (msg: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
    this.onMessage = onMessage;
    this.onClose = onClose;
  }

  setProtocolVersion(version: string): void {
    this.protocolVersion = version;
    void this.listen();
  }

  private async headers(extra: Record<string, string>): Promise<Record<string, string>> {
    return {
      ...(await authHeaders(this.opts)),
      ...extra,
      ...(this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "MCP-Protocol-Version": this.protocolVersion } : {}),
    };
  }

  private async post(msg: JsonRpcMessage): Promise<Response> {
    const init = async (): Promise<RequestInit> => ({
      method: "POST",
      headers: await this.headers({ "Content-Type": "application/json", Accept: "application/json, text/event-stream" }),
      body: JSON.stringify(msg),
      signal: this.controller.signal,
    });
    const doFetch = this.opts.fetch ?? fetch;
    const res = await doFetch(this.opts.url, await init());
    if (res.status !== 401 || !this.opts.auth) return res;
    await res.body?.cancel().catch(() => undefined);
    return (await this.opts.auth.unauthorized(res.headers.get("www-authenticate"))) ? doFetch(this.opts.url, await init()) : res;
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (this.closed) throw new Error("the connection is closed");
    const res = await this.post(msg);
    const session = res.headers.get("mcp-session-id");
    if (session && msg.method === "initialize") this.sessionId = session;
    if (res.status === 404 && this.sessionId) {
      this.fail(new Error("The server ended the session. Reconnect the server."));
      throw new HttpStatusError(404, "The server ended the session.");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw statusError(res.status, this.opts.url);
    }
    if (res.status === 202 || !res.body) return;
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/event-stream")) {
      // Read in the background: a long tool call keeps this stream open until it answers.
      void deliverSse(res.body, (m) => this.onMessage(m)).catch(() => undefined);
      return;
    }
    const text = await res.text();
    if (!text.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`${new URL(this.opts.url).host} answered with something that is not JSON.`);
    }
    for (const m of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(m as JsonRpcMessage);
  }

  /** The optional GET stream for messages the server starts (such as tools/list_changed). */
  private async listen(): Promise<void> {
    try {
      const res = await (this.opts.fetch ?? fetch)(this.opts.url, { headers: await this.headers({ Accept: "text/event-stream" }), signal: this.controller.signal });
      if (!res.ok || !res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        await res.body?.cancel().catch(() => undefined);
        return;
      }
      await deliverSse(res.body, (m) => this.onMessage(m));
    } catch {
      // The listen stream is optional; requests still work without it.
    }
  }

  private fail(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
    this.onClose(error);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    const session = this.sessionId;
    if (session) {
      const headers = await this.headers({});
      await (this.opts.fetch ?? fetch)(this.opts.url, { method: "DELETE", headers, signal: AbortSignal.timeout(2000) }).catch(() => undefined);
    }
    this.fail();
  }
}

/** Connects to a remote server: Streamable HTTP first, then SSE when the server only speaks that. */
export async function connectRemote(transport: "http" | "sse", opts: HttpOptions & { timeoutMs?: number }): Promise<McpClient> {
  if (transport === "sse") return McpClient.connect(new SseTransport(opts), opts);
  try {
    return await McpClient.connect(new StreamableHttpTransport(opts), opts);
  } catch (error) {
    if (!(error instanceof HttpStatusError) || !FALLBACK_STATUSES.has(error.status)) throw error;
    return McpClient.connect(new SseTransport(opts), opts);
  }
}
