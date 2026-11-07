/** The OpenID Connect sign-in as Perch and the person's browser go through it, for tests. */
import { expect } from "vitest";
import { device, freshEmail, harness, type Harness } from "./helpers";
import { fakeIdp, type FakeIdp, type IdpUser, type Tamper } from "./fake-idp";

export const ADMIN_GROUP = "perch-admins";

/** A harness for a company server signed in through `idp`. */
export function companyHarness(idp: FakeIdp, start = Date.now()) {
  return harness(start, {
    fetch: idp.fetch,
    env: { AUTH_MODE: "company", OIDC_ISSUER: idp.issuer, OIDC_CLIENT_ID: idp.clientId, OIDC_CLIENT_SECRET: idp.clientSecret, OIDC_ADMIN_GROUP: ADMIN_GROUP },
  });
}

/** A company server and its provider, sharing one clock. */
export async function company(options: { alg?: "RS256" | "ES256"; scopes?: string[] } = {}) {
  // One clock for both: the harness's clock drives the server, and the provider reads it too.
  let h: Harness | undefined;
  const idp = await fakeIdp({ ...options, now: () => h?.clock.now ?? Date.now() });
  h = companyHarness(idp);
  return { h, idp };
}

export const user = (name = "person"): IdpUser => ({ sub: `sub-${name}-${crypto.randomUUID()}`, email: freshEmail(name) });

export type Started = { requestId: string; pollSecret: string; matchNumber: number; url: string; expiresAt: number };

export async function begin(h: Harness, dev?: { name: string; kind: string; publicKey: string }): Promise<Started> {
  const res = await h.call("POST", "/v1/auth/oidc/start", { body: { device: dev ?? (await device("Work Mac")) } });
  expect(res.status).toBe(200);
  return res.data;
}

const requestIdOf = (start: Started) => new URL(start.url).searchParams.get("r")!;

/** Types the number on the go page. Returns the provider URL and the cookie the page was given. */
export async function typeNumber(h: Harness, start: Started, match = start.matchNumber) {
  const res = await h.call("POST", "/v1/auth/oidc/go", { body: { requestId: requestIdOf(start), match } });
  const cookie = (res.res.headers.get("set-cookie") ?? "").split(";")[0]!;
  return { ...res, url: res.data?.url as string, cookie };
}

export async function callback(h: Harness, path: string, cookie?: string) {
  return h.call("GET", path, cookie ? { headers: { cookie } } : {});
}

export const poll = (h: Harness, start: Started) => h.call("POST", "/v1/auth/oidc/poll", { body: { requestId: start.requestId, pollSecret: start.pollSecret } });

/** The whole sign-in, as Perch and the person's browser do it. */
export async function signInOidc(h: Harness, idp: FakeIdp, who: IdpUser, options: { tamper?: Tamper; device?: { name: string; kind: string; publicKey: string } } = {}) {
  const start = await begin(h, options.device);
  const go = await typeNumber(h, start);
  expect(go.status).toBe(200);
  const back = await callback(h, idp.authorize(go.url, who, options.tamper), go.cookie);
  const polled = await poll(h, start);
  return { start, go, back, polled };
}
