import { createApp } from "./app";
import { cleanup } from "./cleanup";
import type { AppEnv } from "./env";
import { mailerFromEnv } from "./mailer";

export { RateLimiter } from "./ratelimit";
export { RelayRoom } from "./relay";

export default {
  fetch(request, env, ctx) {
    return createApp({ mailer: mailerFromEnv(env), now: Date.now, fetch: (input, init) => fetch(input, init) }).fetch(request, env, ctx);
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanup(env, Date.now()));
  },
} satisfies ExportedHandler<AppEnv>;
