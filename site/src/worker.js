// perchbrowser.com: static pages from ./public plus three jobs the assets layer can't do alone:
// send http and www to https on the apex, serve the passkey association file, and add security headers to
// every response.

const APEX = "perchbrowser.com";

const AASA = JSON.stringify({ webcredentials: { apps: ["VTQW687WBQ.co.xanom.perch"] } });

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
};

// Fonts and images keep their names between deploys, so a week is the longest safe cache.
const LONG_CACHE = /^\/(fonts|img)\//;

function withHeaders(response, extra = {}) {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries({ ...SECURITY_HEADERS, ...extra })) out.headers.set(name, value);
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.protocol !== "https:" || url.hostname !== APEX) {
      return withHeaders(Response.redirect(`https://${APEX}${url.pathname}${url.search}`, 301));
    }

    if (url.pathname === "/.well-known/apple-app-site-association") {
      return withHeaders(new Response(AASA, { status: 200 }), {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      });
    }

    const response = await env.ASSETS.fetch(request);
    const extra = LONG_CACHE.test(url.pathname) && response.ok ? { "Cache-Control": "public, max-age=604800" } : {};
    return withHeaders(response, extra);
  },
};
