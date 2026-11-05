/** Server-sent events: a parser, and the older HTTP+SSE MCP transport (protocol 2024-11-05). */

import type { JsonRpcMessage, Transport } from "./jsonrpc";

export type SseEvent = { event: string; data: string; id?: string };

/** The chunks of a stream, released when the reader stops early. */
export async function* chunks(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Parses an event stream per the HTML spec: events end at a blank line; data lines join with \n. */
export async function* parseSse(stream: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;
  for await (const chunk of chunks(stream)) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith("\r\n", nl) ? 2 : 1));
      if (line === "") {
        if (data.length) yield { event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) };
        event = "";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      else if (field === "id") id = value;
    }
  }
}

/** Delivers each JSON-RPC message in an event stream; malformed events are skipped. */
export async function deliverSse(stream: ReadableStream<Uint8Array>, onMessage: (msg: JsonRpcMessage) => void): Promise<void> {
  for await (const ev of parseSse(stream)) {
    if (ev.event !== "message") continue;
    try {
      const parsed = JSON.parse(ev.data);
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) onMessage(m);
    } catch {
      // skip
    }
  }
}

export type HttpOptions = { url: string; headers: Record<string, string>; fetch?: typeof fetch; auth?: AuthProvider };

/** Supplies the Authorization header and handles a 401 (OAuth sign-in); see oauth.ts. */
export interface AuthProvider {
  header(): Promise<string | undefined>;
  /** Called on a 401. Returns true when a new token was obtained and the request should be retried. */
  unauthorized(wwwAuthenticate: string | null): Promise<boolean>;
}

export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpStatusError";
  }
}

export function statusError(status: number, url: string): HttpStatusError {
  const host = new URL(url).host;
  if (status === 401 || status === 403) return new HttpStatusError(status, `${host} refused the request (HTTP ${status}). Check the server's sign-in or token.`);
  return new HttpStatusError(status, `${host} answered HTTP ${status}.`);
}

export async function authHeaders(opts: HttpOptions): Promise<Record<string, string>> {
  const auth = await opts.auth?.header();
  return { ...opts.headers, ...(auth ? { Authorization: auth } : {}) };
}

/** The legacy transport: a GET event stream that names a POST endpoint, replies arrive on the stream. */
export class SseTransport implements Transport {
  private readonly controller = new AbortController();
  private endpoint: string | null = null;

  constructor(private readonly opts: HttpOptions) {}

  async start(onMessage: (msg: JsonRpcMessage) => void, onClose: (error?: Error) => void): Promise<void> {
    const doFetch = this.opts.fetch ?? fetch;
    const open = async () => doFetch(this.opts.url, { headers: { ...(await authHeaders(this.opts)), Accept: "text/event-stream" }, signal: this.controller.signal });
    let res = await open();
    if (res.status === 401 && this.opts.auth && (await this.opts.auth.unauthorized(res.headers.get("www-authenticate")))) res = await open();
    if (!res.ok || !res.body) throw statusError(res.status, this.opts.url);
    const body = res.body;
    const reader = async () => {
      for await (const ev of parseSse(body)) {
        if (ev.event === "endpoint" && !this.endpoint) {
          const endpoint = new URL(ev.data.trim(), this.opts.url);
          // Messages only ever go to the server that was configured.
          if (endpoint.origin !== new URL(this.opts.url).origin) throw new Error("The SSE server named a message endpoint on another site.");
          this.endpoint = endpoint.toString();
          onEndpoint();
        } else if (ev.event === "message") {
          try {
            onMessage(JSON.parse(ev.data));
          } catch {
            // skip
          }
        }
      }
    };
    let onEndpoint: () => void = () => undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      onEndpoint = resolve;
      timer = setTimeout(() => reject(new Error("The SSE server did not send its message endpoint.")), 15_000);
    });
    const done = reader();
    void done.then(
      () => onClose(),
      (error: Error) => onClose(this.controller.signal.aborted ? undefined : error),
    );
    const endedEarly = done.then(() => Promise.reject(new Error("The SSE stream ended before it was ready.")));
    endedEarly.catch(() => undefined); // only matters while waiting for the endpoint
    ready.catch(() => undefined);
    try {
      await Promise.race([ready, endedEarly]);
    } catch (error) {
      this.controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(msg: JsonRpcMessage): Promise<void> {
    if (!this.endpoint) throw new Error("the SSE connection is not ready");
    const res = await (this.opts.fetch ?? fetch)(this.endpoint, {
      method: "POST",
      headers: { ...(await authHeaders(this.opts)), "Content-Type": "application/json" },
      body: JSON.stringify(msg),
      signal: this.controller.signal,
    });
    await res.body?.cancel().catch(() => undefined);
    if (!res.ok) throw statusError(res.status, this.endpoint);
  }

  async close(): Promise<void> {
    this.controller.abort();
  }
}
