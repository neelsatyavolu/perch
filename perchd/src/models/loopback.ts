/**
 * A one-shot localhost listener for the OAuth redirect (the redirect URIs belong to the Codex and
 * Grok CLIs' registrations, so the ports are fixed). Binds 127.0.0.1 only and closes itself after
 * the sign-in or the timeout. When the port is taken the user pastes the address instead.
 */

export type LoopbackResult = { ok: boolean; /** A stale or unrelated request: answer it and keep listening. */ ignore?: boolean };
export type LoopbackOptions = { port: number; path: string; ttlMs: number; handle: (url: URL) => Promise<LoopbackResult>; onClose?: () => void };
export type LoopbackHandle = { port: number; close(): void };
export type LoopbackStarter = (opts: LoopbackOptions) => LoopbackHandle | null;

const page = (message: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Perch</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
  `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#ededed;font:14px/1.5 -apple-system,system-ui,sans-serif">` +
  `<p>${message}</p></body></html>`;

export const SIGNED_IN_PAGE = page("Perch is signed in. You can close this tab.");
export const FAILED_PAGE = page("Perch could not finish signing in. Close this tab and try again from Settings → Models.");

export const startLoopback: LoopbackStarter = (opts) => {
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let server: ReturnType<typeof Bun.serve>;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    // Let the answer reach the browser before the socket closes.
    setTimeout(() => server.stop(true), 50);
    opts.onClose?.();
  };
  const headers = { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
  try {
    server = Bun.serve({
      port: opts.port,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== opts.path || req.method !== "GET") return new Response(page("Not found."), { status: 404, headers });
        let result: LoopbackResult = { ok: false };
        try {
          result = await opts.handle(url);
        } catch {
          /* answered as a failure below */
        }
        if (!result.ignore) close();
        return new Response(result.ok ? SIGNED_IN_PAGE : FAILED_PAGE, { status: result.ok ? 200 : 400, headers });
      },
    });
  } catch {
    return null;
  }
  timer = setTimeout(close, opts.ttlMs);
  timer.unref?.();
  return { port: server.port ?? opts.port, close };
};
