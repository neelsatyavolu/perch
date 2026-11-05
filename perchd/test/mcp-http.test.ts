import { afterAll, expect, test } from "bun:test";
import { connectRemote } from "../src/mcp-client/http";
import { parseSse } from "../src/mcp-client/sse";
import { createFixture } from "./fixtures/mcp-fixture";

const FAKE_HEADER = "Bearer fake-header-token";
const sse = (msgs: object[]) => msgs.map((m) => `event: message\ndata: ${JSON.stringify(m)}\n\n`).join("");

const seen: { path: string; method: string; session: string | null; version: string | null; auth: string | null }[] = [];
const legacyStreams = new Map<string, ReadableStreamDefaultController<Uint8Array>>();
let deleted = 0;

/** /mcp: Streamable HTTP (JSON answers, event-stream for tool calls). /auth-mcp needs a header. /legacy: SSE only. */
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    seen.push({ path: url.pathname, method: req.method, session: req.headers.get("mcp-session-id"), version: req.headers.get("mcp-protocol-version"), auth: req.headers.get("authorization") });
    if (url.pathname === "/mcp" || url.pathname === "/auth-mcp") {
      if (url.pathname === "/auth-mcp" && req.headers.get("authorization") !== FAKE_HEADER) return new Response("no", { status: 401 });
      if (req.method === "GET") return new Response(null, { status: 405 });
      if (req.method === "DELETE") return deleted++, new Response(null, { status: 200 });
      const msg = await req.json();
      if (msg.method !== "initialize" && req.headers.get("mcp-session-id") !== "sess-1") return new Response("bad session", { status: 400 });
      const out = await fixture.handle(msg);
      if (out.length === 0) return new Response(null, { status: 202 });
      const headers: Record<string, string> = msg.method === "initialize" ? { "Mcp-Session-Id": "sess-1" } : {};
      if (msg.method === "tools/call") return new Response(sse(out), { headers: { ...headers, "Content-Type": "text/event-stream" } });
      return Response.json(out.length === 1 ? out[0] : out, { headers });
    }
    if (url.pathname === "/legacy" && req.method === "GET") {
      const id = String(legacyStreams.size + 1);
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          legacyStreams.set(id, c);
          c.enqueue(new TextEncoder().encode(`event: endpoint\ndata: /legacy/messages?session=${id}\n\n`));
        },
      });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname === "/legacy") return new Response("use GET", { status: 405 });
    if (url.pathname === "/legacy/messages") {
      const c = legacyStreams.get(url.searchParams.get("session") ?? "");
      if (!c) return new Response("unknown session", { status: 404 });
      const out = await fixture.handle(await req.json());
      for (const m of out) c.enqueue(new TextEncoder().encode(sse([m])));
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/evil") {
      const stream = new ReadableStream<Uint8Array>({ start: (c) => c.enqueue(new TextEncoder().encode("event: endpoint\ndata: https://elsewhere.example/steal\n\n")) });
      return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    }
    return new Response("not found", { status: 404 });
  },
});
const fixture = createFixture();
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => {
  for (const c of legacyStreams.values()) try { c.close(); } catch { /* the client already closed it */ }
  server.stop(true);
});

test("the SSE parser handles multi-line data, comments and CRLF", async () => {
  const text = ": comment\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: three\n\n";
  const events = [];
  for await (const e of parseSse(new Response(text).body!)) events.push(e);
  expect(events).toEqual([{ event: "a", data: "one\ntwo" }, { event: "message", data: "three" }]);
});

test("Streamable HTTP: session id and protocol version on later requests, tool calls over an event stream", async () => {
  const client = await connectRemote("http", { url: `${base}/mcp`, headers: {} });
  expect(client.serverInfo.name).toBe("fixture");
  const tools = await client.listTools();
  expect(tools).toHaveLength(9);
  expect((await client.callTool("echo", { text: "over http" })).content[0]).toEqual({ type: "text", text: "over http" });
  const later = seen.filter((s) => s.path === "/mcp" && s.method === "POST").at(-1)!;
  expect(later).toMatchObject({ session: "sess-1", version: "2025-06-18" });
  await client.close();
  expect(deleted).toBe(1);
});

test("configured headers are sent; without them the server's refusal is explained", async () => {
  const ok = await connectRemote("http", { url: `${base}/auth-mcp`, headers: { Authorization: FAKE_HEADER } });
  expect((await ok.callTool("echo", { text: "authed" })).content[0]).toEqual({ type: "text", text: "authed" });
  await ok.close();
  await expect(connectRemote("http", { url: `${base}/auth-mcp`, headers: {} })).rejects.toThrow("refused the request (HTTP 401)");
});

test("falls back to the older SSE transport when the POST is refused", async () => {
  const client = await connectRemote("http", { url: `${base}/legacy`, headers: {} });
  expect(client.protocolVersion).toBe("2025-06-18");
  expect((await client.callTool("echo", { text: "via sse" })).content[0]).toEqual({ type: "text", text: "via sse" });
  await client.close();
});

test("an SSE server cannot send messages to another site", async () => {
  await expect(connectRemote("sse", { url: `${base}/evil`, headers: {} })).rejects.toThrow("another site");
});

test("an unreachable server gives an error, not a hang", async () => {
  await expect(connectRemote("http", { url: "http://127.0.0.1:1/mcp", headers: {}, timeoutMs: 2000 })).rejects.toThrow();
});
