import { join } from "node:path";

const PAGES = join(import.meta.dir, "pages");

/** Serves test/fixtures/pages on a free localhost port. */
export function startFixtures(): { url: (path: string) => string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === "/redirect") return Response.redirect("/mail.html", 302);
      if (pathname === "/slow-page") return Bun.sleep(800).then(() => new Response(Bun.file(join(PAGES, "shop.html")), { headers: { "content-type": "text/html; charset=utf-8" } }));
      if (pathname === "/slow") return new Promise((resolve) => setTimeout(() => resolve(new Response("<title>Slow</title>", { headers: { "content-type": "text/html" } })), 2000));
      const file = Bun.file(join(PAGES, pathname.replace(/^\/+/, "") || "mail.html"));
      if (!(await file.exists()) || pathname.includes("..")) return new Response("not found", { status: 404 });
      return new Response(file, { headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  return { url: (path) => `http://127.0.0.1:${server.port}${path}`, stop: () => server.stop(true) };
}
