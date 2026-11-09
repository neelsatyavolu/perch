import { Hono } from "hono";
import { authMode, type Deps, type HonoEnv } from "./env";
import { clientIp, HttpError } from "./http";
import { logEvent } from "./log";
import { consume, RULES } from "./ratelimit";
import { accountRoutes } from "./account";
import { adminRoutes } from "./admin";
import { confirmRoutes } from "./auth/confirm-action";
import { emailRoutes } from "./auth/email";
import { oidcRoutes } from "./auth/oidc";
import { passkeyRoutes } from "./auth/passkey";
import { deviceRoutes } from "./devices";
import { keyRoutes } from "./keys";
import { pairingRoutes } from "./pairing";
import { relayRoutes } from "./relay";
import { syncRoutes } from "./sync";

/** No cookies, no CORS, no framing, no caching: every response gets these. */
const SECURITY_HEADERS: Record<string, string> = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Cross-Origin-Resource-Policy": "same-origin",
};
const JSON_CSP = "default-src 'none'; frame-ancestors 'none'";
const PUBLIC_SIGN_IN = /^\/v1\/auth\/(email|passkey\/(register|login))(\/|$)/;

export function createApp(deps: Deps): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();

  app.use(async (c, next) => {
    const started = Date.now();
    c.set("deps", deps);
    await next();
    // A WebSocket upgrade response comes back from the relay object with fixed headers.
    if (c.res.status !== 101) {
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.res.headers.set(name, value);
      if (!c.res.headers.has("Content-Security-Policy")) c.res.headers.set("Content-Security-Policy", JSON_CSP);
    }
    logEvent("request", { method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started });
  });

  // A cheap per-IP ceiling in front of everything, on top of each route's own limit.
  app.use(async (c, next) => {
    if (c.req.path !== "/health") await consume(c.env, RULES.publicIp, clientIp(c));
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true }));

  // Company mode signs people in only through the company's identity provider: email and passkey
  // sign-in are not there at all. Pairing stays, since it starts from a signed-in device.
  app.use(async (c, next) => {
    if (c.req.path !== "/health" && authMode(c.env) === "company" && PUBLIC_SIGN_IN.test(c.req.path)) {
      throw new HttpError(404, "not_found", "There is nothing at this address.");
    }
    await next();
  });
  /** Which sign-in Perch should offer for this server (the SyncServerURL policy points here). */
  app.get("/v1/server", (c) => c.json({ auth: authMode(c.env) === "company" ? ["oidc"] : ["email", "passkey"], name: c.env.RP_NAME }));
  app.route("/v1/auth/oidc", oidcRoutes);
  app.route("/v1/admin", adminRoutes);
  app.route("/v1/auth/email", emailRoutes);
  app.route("/v1/auth/passkey", passkeyRoutes);
  app.route("/v1/account/confirm", confirmRoutes);
  app.route("/v1/account", accountRoutes);
  app.route("/v1/devices", deviceRoutes);
  app.route("/v1/keys", keyRoutes);
  app.route("/v1/sync", syncRoutes);
  app.route("/v1/pair", pairingRoutes);
  app.route("/v1/relay", relayRoutes);

  app.notFound((c) => c.json({ error: { code: "not_found", message: "There is nothing at this address." } }, 404));
  app.onError((error, c) => {
    if (error instanceof HttpError) {
      for (const [name, value] of Object.entries(error.headers)) c.header(name, value);
      return c.json({ error: { code: error.code, message: error.message } }, error.status as 400);
    }
    logEvent("unhandled_error", { route: c.req.routePath, error: error instanceof Error ? error.name : "unknown" });
    return c.json({ error: { code: "server_error", message: "Something went wrong on the server. Try again." } }, 500);
  });
  return app;
}
