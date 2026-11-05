import { join } from "node:path";

const PAGES = join(import.meta.dir, "pages");

export type Hit = { host: string; path: string; query: string };

/**
 * Serves test/fixtures/pages on a free port for every *.localhost name (Chrome resolves them all
 * to loopback), records each request, and answers any .js path with a small script.
 */
export function startFixtures(): { port: number; url: (host: string, path: string) => string; hits: Hit[]; stop: () => void } {
  const hits: Hit[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const host = (req.headers.get("host") ?? "").split(":")[0] ?? "";
      hits.push({ host, path: url.pathname, query: url.search });
      if (url.pathname.includes("..")) return new Response("not found", { status: 404 });
      const file = Bun.file(join(PAGES, url.pathname.replace(/^\/+/, "")));
      if (await file.exists()) {
        const type = url.pathname.endsWith(".html") ? "text/html; charset=utf-8" : url.pathname.endsWith(".webm") ? "video/webm" : file.type;
        return new Response(file, { headers: { "content-type": type } });
      }
      if (url.pathname.endsWith(".js")) return new Response(`/* ${host}${url.pathname} */`, { headers: { "content-type": "text/javascript" } });
      if (url.pathname.endsWith(".pdf")) return new Response("%PDF-1.4", { headers: { "content-type": "application/pdf", "content-length": "8" } });
      return new Response("not found", { status: 404 });
    },
  });
  const port = server.port!;
  return { port, url: (host, path) => `http://${host}:${port}${path}`, hits, stop: () => server.stop(true) };
}
