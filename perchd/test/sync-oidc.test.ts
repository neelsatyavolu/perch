/**
 * The sync client's company sign-in calls against a fake fetch. The real routes are tested in
 * server/test/oidc.test.ts.
 */
import { describe, expect, it } from "bun:test";
import { SyncApi, SyncApiError, type FetchLike } from "../src/sync/api";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const device = { name: "Work Mac", kind: "browser" as const, publicKey: "A".repeat(87) };

function fakeCompanyServer() {
  const calls: { method: string; path: string; body: unknown }[] = [];
  let polls = 0;
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body });
    if (url.pathname === "/v1/server") return json({ auth: ["oidc"], name: "Acme Perch" });
    if (url.pathname === "/v1/auth/oidc/start") {
      return json({ requestId: "oreq_1", pollSecret: "ops_1", matchNumber: 42, url: "https://sync.acme.example/v1/auth/oidc/go?r=oreq_1", expiresAt: 1 });
    }
    if (url.pathname === "/v1/auth/oidc/poll") {
      polls++;
      if (polls === 1) return json({ status: "pending" });
      if (polls === 2) return json({ status: "signed_in", sessionToken: "pst_x", accountId: "acc_1", deviceId: "dev_1", admin: true });
      return json({ error: { code: "expired", message: "This sign-in request has expired or was cancelled. Start again in Perch." } }, 410);
    }
    return json({ error: { code: "not_found", message: "There is nothing at this address." } }, 404);
  };
  return { fetch, calls };
}

describe("company sign-in client", () => {
  it("asks the server which sign-in it offers", async () => {
    const server = fakeCompanyServer();
    const api = new SyncApi({ baseUrl: "https://sync.acme.example", fetch: server.fetch });
    expect(await api.serverInfo()).toEqual({ auth: ["oidc"], name: "Acme Perch" });
    expect(server.calls[0]).toEqual({ method: "GET", path: "/v1/server", body: undefined });
  });

  it("starts a sign-in with the device and polls with the request id and secret until it gets the session once", async () => {
    const server = fakeCompanyServer();
    const api = new SyncApi({ baseUrl: "https://sync.acme.example", fetch: server.fetch });
    const start = await api.startOidc(device);
    expect(start.matchNumber).toBe(42);
    expect(start.url).toBe("https://sync.acme.example/v1/auth/oidc/go?r=oreq_1");
    expect(server.calls.at(-1)).toEqual({ method: "POST", path: "/v1/auth/oidc/start", body: { device } });

    expect(await api.pollOidc(start)).toEqual({ status: "pending" });
    expect(server.calls.at(-1)!.body).toEqual({ requestId: "oreq_1", pollSecret: "ops_1" });
    expect(await api.pollOidc(start)).toEqual({ status: "signed_in", sessionToken: "pst_x", accountId: "acc_1", deviceId: "dev_1", admin: true });

    const gone = await api.pollOidc(start).catch((error: unknown) => error);
    expect(gone).toBeInstanceOf(SyncApiError);
    expect((gone as SyncApiError).status).toBe(410);
    expect((gone as SyncApiError).code).toBe("expired");
  });

  it("surfaces the 404 a public server gives for company sign-in", async () => {
    const api = new SyncApi({ fetch: async () => json({ error: { code: "not_found", message: "There is nothing at this address." } }, 404) });
    const error = await api.startOidc(device).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncApiError);
    expect((error as SyncApiError).status).toBe(404);
  });
});
