/**
 * HTTP and WebSocket for the app API, on a loopback port or a Unix socket.
 *
 * Every API call needs the per-launch token: `Authorization: Bearer <token>` on HTTP, and the
 * subprotocol `token.<token>` next to `perch-app` on the WebSocket (browsers cannot set headers
 * there). A request from a browser page must come from one of Perch's own origins, and on a port
 * the Host header must be the loopback address, which stops DNS rebinding.
 */

import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { AppError } from "./runs";
import { match, type RouteContext } from "./routes";
import type { AppEvent } from "./protocol";

export type Listen = { port: number } | { unix: string };
export type Server = { url: string; origin: string | null; publish(event: AppEvent): void; stop(): void };

export const PROTOCOL = "perch-app";
const MAX_BODY = 12_000_000;
const TOPIC = "events";

type Options = {
  token: string;
  /**
   * Inside Perch, the browser's own token for reporting tabs (activation, titles, closes). Pages
   * never get it, so a page cannot tell perchd that some tab is the one the user is looking at.
   * Without it (development), the page token reports tabs too.
   */
  browserToken?: string;
  allowedOrigins: string[];
  listen: Listen;
  uiDir?: string;
  ctx: RouteContext;
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function startServer(opts: Options): Server {
  const onPort = "port" in opts.listen;
  let selfOrigin: string | null = null;
  const originAllowed = (origin: string | null) => origin === null || opts.allowedOrigins.includes(origin) || origin === selfOrigin;
  const cors = (origin: string | null): Record<string, string> =>
    origin && origin !== selfOrigin && opts.allowedOrigins.includes(origin)
      ? { "access-control-allow-origin": origin, vary: "Origin", "access-control-allow-headers": "authorization, content-type", "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE" }
      : {};

  async function handleApi(req: Request, url: URL, origin: string | null): Promise<Response> {
    const headers = cors(origin);
    const auth = req.headers.get("authorization") ?? "";
    const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    const isBrowser = opts.browserToken !== undefined && same(given, opts.browserToken);
    if (!isBrowser && !same(given, opts.token)) return json({ error: "Not signed in to this Perch session" }, 401, headers);
    const found = match(req.method, url.pathname);
    if (found === "method") return json({ error: "method not allowed" }, 405, headers);
    if (!found) return json({ error: "not found" }, 404, headers);
    // The browser token reports tabs and does nothing else; pages never report tabs inside Perch.
    if (opts.browserToken !== undefined && found.browser !== isBrowser) return json({ error: "Not allowed with this token" }, 403, headers);
    try {
      let body: unknown;
      if (req.method === "POST" || req.method === "PUT" || req.method === "PATCH") {
        if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY) throw new AppError("The request is too large", 413);
        const raw = await req.text();
        if (raw.length > MAX_BODY) throw new AppError("The request is too large", 413);
        if (raw && !(req.headers.get("content-type") ?? "").startsWith("application/json")) throw new AppError("Send JSON with Content-Type: application/json", 415);
        try {
          body = raw ? JSON.parse(raw) : undefined;
        } catch {
          throw new AppError("The request body is not valid JSON");
        }
      }
      const result = await found.handler(opts.ctx, found.params, body, url.searchParams);
      if (result instanceof Response) {
        for (const [k, val] of Object.entries(headers)) result.headers.set(k, val);
        return result;
      }
      return json(result, 200, headers);
    } catch (error) {
      const status = error instanceof AppError ? error.status : 500;
      const message = error instanceof AppError ? error.message : "Something went wrong in Perch. Try again; if it keeps happening, restart Perch";
      return json({ error: message }, status, headers);
    }
  }

  function serveUi(pathname: string): Response {
    const dir = opts.uiDir!;
    const rel = normalize(decodeURIComponent(pathname.slice("/ui/".length)) || "chat.html");
    // Inside Perch the browser serves config.js; here the pages read their config from the
    // address's fragment, so the script is empty.
    if (rel === "config.js") return new Response("", { headers: { "content-type": "text/javascript", "x-content-type-options": "nosniff" } });
    const file = join(dir, rel);
    if (!file.startsWith(dir + sep) || !existsSync(file) || !statSync(file).isFile()) return new Response("not found", { status: 404 });
    return new Response(Bun.file(file), {
      headers: {
        "content-security-policy": `default-src 'self'; connect-src 'self' ws://${new URL(server.url).host}; img-src 'self' data: ${artifactOriginFor()}; frame-src ${artifactOriginFor()}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com`,
        "x-content-type-options": "nosniff",
      },
    });
  }
  const artifactOriginFor = () => opts.ctx.artifactServer.origin;

  const server = Bun.serve<{ ok: true }, never>({
    ...(onPort ? { hostname: "127.0.0.1", port: (opts.listen as { port: number }).port } : { unix: (opts.listen as { unix: string }).unix }),
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (onPort) {
        const host = req.headers.get("host");
        if (host !== `127.0.0.1:${server.port}` && host !== `localhost:${server.port}`) return new Response("wrong host", { status: 403 });
      }
      const origin = req.headers.get("origin");
      if (!originAllowed(origin)) return new Response("origin not allowed", { status: 403 });
      if (url.pathname === "/ws") {
        const offered = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
        const token = offered.find((p) => p.startsWith("token."))?.slice(6) ?? "";
        if (!offered.includes(PROTOCOL) || !same(token, opts.token)) return new Response("not signed in", { status: 401 });
        if (srv.upgrade(req, { data: { ok: true }, headers: { "sec-websocket-protocol": PROTOCOL } })) return undefined as unknown as Response;
        return new Response("expected a WebSocket", { status: 400 });
      }
      if (req.method === "OPTIONS") return new Response(null, { status: origin && cors(origin)["access-control-allow-origin"] ? 204 : 403, headers: cors(origin) });
      if (url.pathname.startsWith("/api/")) {
        const res = await handleApi(req, url, origin);
        // Refusals go to perchd's log: the browser's own reports have no other place to show them.
        if (res.status >= 400) console.error(`app api: ${req.method} ${url.pathname} -> ${res.status}`);
        return res;
      }
      if (opts.uiDir && url.pathname.startsWith("/ui/") && req.method === "GET") return serveUi(url.pathname);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.subscribe(TOPIC);
      },
      message(ws, message) {
        if (message === "ping") ws.send("pong");
      },
    },
  });
  // Only the owner may connect to the socket (spec 7.1).
  if (!onPort) chmodSync((opts.listen as { unix: string }).unix, 0o600);
  const url = onPort ? `http://127.0.0.1:${server.port}` : `unix:${(opts.listen as { unix: string }).unix}`;
  selfOrigin = onPort ? url : null;
  return {
    url,
    origin: selfOrigin,
    publish: (event) => {
      server.publish(TOPIC, JSON.stringify(event));
    },
    stop: () => server.stop(true),
  };
}
