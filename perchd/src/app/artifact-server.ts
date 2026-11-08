/**
 * The isolated origin artifacts render from (spec 7.7). It is a separate loopback port, so it is a
 * different origin from Perch's pages and the app API. Every response carries a CSP with
 * `sandbox allow-scripts` (an opaque origin: no cookies, storage or access to other pages), no
 * network except a few CDNs for scripts, styles, fonts and images, and only Perch's pages may
 * frame it. Inside Chromium this becomes `perch-artifact://<id>` (docs/design/webui-hosting.md).
 *
 * Addresses carry a capability, an HMAC of the artifact id and version under a per-launch secret,
 * so another local page cannot guess its way to a chat's artifacts.
 *
 * Limit: CSP cannot stop a page from navigating its own frame (`location = "https://..."`) or a
 * `<meta http-equiv="refresh">`, and either can carry data out in the address. No popups are
 * allowed, so `window.open` is closed. Inside Perch a navigation throttle on artifact frames must
 * cancel every navigation that leaves `perch-artifact://` (docs/design/webui-hosting.md). In this
 * development server that gap stays open.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { ArtifactStore } from "./artifacts";

export const ARTIFACT_CDNS = ["https://cdn.jsdelivr.net", "https://cdnjs.cloudflare.com", "https://unpkg.com"];

export type ArtifactServer = {
  origin: string;
  urlFor(id: string, version: number): string;
  /** A version's response with its CSP, for the browser's `perch-artifact://` loader (no capability needed). */
  serve(id: string, version: number): Response;
  stop(): void;
};

/** The scheme Perch's browser serves artifacts on (plan 3b task 12). */
export const ARTIFACT_SCHEME = "perch-artifact";

export function artifactCsp(frameAncestors: string[]): string {
  const cdns = ARTIFACT_CDNS.join(" ");
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' ${cdns}`,
    `style-src 'unsafe-inline' ${cdns} https://fonts.googleapis.com`,
    `font-src data: ${cdns} https://fonts.gstatic.com`,
    `img-src data: blob: ${cdns}`,
    "media-src data: blob:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    `frame-ancestors ${frameAncestors.length ? frameAncestors.join(" ") : "'none'"}`,
    "sandbox allow-scripts",
  ].join("; ");
}

const TEXT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  svg: "image/svg+xml",
  markdown: "text/plain; charset=utf-8",
  code: "text/plain; charset=utf-8",
  csv: "text/plain; charset=utf-8",
  json: "text/plain; charset=utf-8",
};

export function startArtifactServer(opts: {
  store: ArtifactStore;
  frameAncestors: string[] | (() => string[]);
  port?: number;
  /**
   * Inside Perch: addresses are `perch-artifact://<id>/<version>`, which the browser loads through
   * the app API's browser-only route (`serve`), so no capability ever shows in an address.
   */
  browserScheme?: boolean;
}): ArtifactServer {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const sign = (id: string, version: number) => createHmac("sha256", secret).update(`${id}/${version}`).digest("base64url");
  const ancestors = typeof opts.frameAncestors === "function" ? opts.frameAncestors : () => opts.frameAncestors as string[];
  const serve = (id: string, version: number): Response => {
    const record = opts.store.get(id);
    const content = version >= 1 ? opts.store.content(id, version) : undefined;
    if (!record || !content) return new Response("not found", { status: 404 });
    const headers = {
      "content-security-policy": artifactCsp(ancestors()),
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "cross-origin-resource-policy": "cross-origin",
      "cache-control": "no-store",
    };
    if (record.kind === "image") {
      return new Response(Buffer.from(content.content, "base64"), { headers: { ...headers, "content-type": content.mime ?? "application/octet-stream" } });
    }
    return new Response(content.content, { headers: { ...headers, "content-type": TEXT_TYPES[record.kind] ?? "text/plain; charset=utf-8" } });
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("wrong host", { status: 403 });
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
      const match = url.pathname.match(/^\/a\/([0-9a-f-]{36})\/(\d{1,5})$/);
      const key = url.searchParams.get("k") ?? "";
      if (!match) return new Response("not found", { status: 404 });
      const [, id, v] = match;
      const version = Number(v);
      const expected = Buffer.from(sign(id!, version));
      const given = Buffer.from(key);
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return new Response("not found", { status: 404 });
      return serve(id!, version);
    },
  });
  const loopback = `http://127.0.0.1:${server.port}`;
  return opts.browserScheme
    ? { origin: `${ARTIFACT_SCHEME}:`, urlFor: (id, version) => `${ARTIFACT_SCHEME}://${id}/${version}`, serve, stop: () => server.stop(true) }
    : { origin: loopback, urlFor: (id, version) => `${loopback}/a/${id}/${version}?k=${sign(id, version)}`, serve, stop: () => server.stop(true) };
}
