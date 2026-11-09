import { describe, expect, it } from "vitest";
import { device, harness, signIn, type Harness } from "./helpers";
import { ADMIN_GROUP, company, signInOidc, user } from "./oidc-flow";

async function connectRelay(h: Harness, token: string) {
  const res = await h.call("GET", "/v1/relay", { token, headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.res.webSocket!;
  const closed = new Promise<number>((resolve) => ws.addEventListener("close", (event) => resolve(event.code)));
  ws.accept();
  return { ws, closed };
}

const adminUser = (name = "admin") => ({ ...user(name), groups: [ADMIN_GROUP] });

describe("company admin", () => {
  it("lets an admin list and revoke devices, and closes the revoked device's relay socket", async () => {
    const { h, idp } = await company();
    const admin = (await signInOidc(h, idp, adminUser())).polled.data;
    const who = user("member");
    const member = (await signInOidc(h, idp, who, { device: await device("Member Mac") })).polled.data;
    await h.env.DB.prepare("INSERT INTO wrapped_keys (account_id, slot, version, blob, updated_at) VALUES (?, ?, 1, 'c2VhbGVk', 0)")
      .bind(member.accountId, member.deviceId).run();
    const socket = await connectRelay(h, member.sessionToken);

    const listed = await h.call("GET", "/v1/admin/devices", { token: admin.sessionToken });
    expect(listed.status).toBe(200);
    const row = listed.data.devices.find((d: { id: string }) => d.id === member.deviceId);
    expect(row).toEqual({
      id: member.deviceId, accountEmail: who.email, name: "Member Mac", kind: "browser",
      createdAt: expect.any(Number), lastSeenAt: expect.any(Number), revokedAt: null,
    });
    // Names, kinds and dates only: no keys, no data.
    expect(Object.keys(row).sort()).toEqual(["accountEmail", "createdAt", "id", "kind", "lastSeenAt", "name", "revokedAt"]);

    const revoked = await h.call("DELETE", `/v1/admin/devices/${member.deviceId}`, { token: admin.sessionToken });
    expect(revoked.status).toBe(200);
    expect(await socket.closed).toBe(4001);
    expect((await h.call("GET", "/v1/account", { token: member.sessionToken })).status).toBe(401);
    const keys = await h.env.DB.prepare("SELECT COUNT(*) AS n FROM wrapped_keys WHERE slot = ?").bind(member.deviceId).first<number>("n");
    expect(keys).toBe(0);
    const sessions = await h.env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE device_id = ?").bind(member.deviceId).first<number>("n");
    expect(sessions).toBe(0);

    const after = await h.call("GET", "/v1/admin/devices", { token: admin.sessionToken });
    expect(after.data.devices.find((d: { id: string }) => d.id === member.deviceId).revokedAt).toEqual(expect.any(Number));
    expect((await h.call("DELETE", `/v1/admin/devices/${member.deviceId}`, { token: admin.sessionToken })).status).toBe(404);
    expect((await h.call("DELETE", "/v1/admin/devices/dev_nothing", { token: admin.sessionToken })).status).toBe(404);
  });

  it("refuses admin routes to a non-admin, a CLI session, and an admin session older than 12 hours", async () => {
    const { h, idp } = await company();
    const target = (await signInOidc(h, idp, user("target"))).polled.data;
    const del = (token?: string) => h.call("DELETE", `/v1/admin/devices/${target.deviceId}`, token ? { token } : {});
    const list = (token?: string) => h.call("GET", "/v1/admin/devices", token ? { token } : {});

    expect((await list()).status).toBe(401);

    const member = (await signInOidc(h, idp, user("member"))).polled.data;
    expect((await list(member.sessionToken)).status).toBe(403);
    expect((await del(member.sessionToken)).status).toBe(403);

    const cli = (await signInOidc(h, idp, adminUser("cli"), { device: await device("Build box", "cli") })).polled.data;
    expect(cli.admin).toBe(true);
    expect((await list(cli.sessionToken)).status).toBe(403);

    const admin = (await signInOidc(h, idp, adminUser())).polled.data;
    expect((await list(admin.sessionToken)).status).toBe(200);
    h.clock.now += 12 * 60 * 60 * 1000 + 1;
    const old = await list(admin.sessionToken);
    expect(old.status).toBe(403);
    expect(old.data.error.code).toBe("admin_reauth");
    expect((await del(admin.sessionToken)).status).toBe(403);
    // The session itself still works for everything else.
    expect((await h.call("GET", "/v1/account", { token: admin.sessionToken })).status).toBe(200);

    // A public server has no admin routes at all.
    const pub = harness();
    const s = await signIn(pub);
    expect((await pub.call("GET", "/v1/admin/devices", { token: s.sessionToken })).status).toBe(404);
  });
});
