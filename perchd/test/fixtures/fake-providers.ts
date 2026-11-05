/** A local HTTP server standing in for model providers in tests. It records every request. */

export type Seen = { method: string; path: string; search: string; headers: Record<string, string>; body: any };
export type FakeServer = { url: string; seen: Seen[]; stop: () => void };

export function fakeServer(handler: (req: Seen) => Response | Promise<Response>): FakeServer {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const url = new URL(request.url);
      const text = await request.text();
      let body: any = text;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        /* keep the raw text (form bodies) */
      }
      const entry: Seen = { method: request.method, path: url.pathname, search: url.search, headers: request.headers.toJSON(), body };
      seen.push(entry);
      return handler(entry);
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) };
}

/** Server-sent events: each object becomes one `data:` line, then `[DONE]`. */
export function sse(events: object[]): Response {
  const body = `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`;
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

export const json = (value: unknown, status = 200): Response => Response.json(value, { status });

/** A 1×1 PNG, base64. */
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
