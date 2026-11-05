import { describe, expect, it } from "vitest";
import { freshEmail, harness, signIn, type Harness, type Session } from "./helpers";

type Socket = { ws: WebSocket; next: (pred?: (m: any) => boolean) => Promise<any>; closed: Promise<{ code: number }> };

async function connect(h: Harness, s: Session): Promise<Socket> {
  const res = await h.call("GET", "/v1/relay", { token: s.sessionToken, headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.res.webSocket!;
  const inbox: any[] = [];
  const waiters: (() => void)[] = [];
  ws.addEventListener("message", (event) => {
    inbox.push(JSON.parse(event.data as string));
    waiters.splice(0).forEach((wake) => wake());
  });
  const closed = new Promise<{ code: number }>((resolve) => ws.addEventListener("close", (event) => resolve({ code: event.code })));
  ws.accept();
  async function next(pred: (m: any) => boolean = () => true): Promise<any> {
    for (;;) {
      const index = inbox.findIndex(pred);
      if (index >= 0) return inbox.splice(index, 1)[0];
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
  }
  return { ws, next, closed };
}

const presence = (online: string[]) => (m: any) => m.t === "presence" && JSON.stringify([...m.online].sort()) === JSON.stringify([...online].sort());

describe("relay", () => {
  it("needs a session and a WebSocket upgrade", async () => {
    const h = harness();
    expect((await h.call("GET", "/v1/relay", { headers: { Upgrade: "websocket" } })).status).toBe(401);
    const s = await signIn(h);
    expect((await h.call("GET", "/v1/relay", { token: s.sessionToken })).status).toBe(426);
  });

  it("forwards ciphertext between two devices of one account and reports presence", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email);
    const b = await signIn(h, email);
    const sa = await connect(h, a);
    await sa.next(presence([a.deviceId]));
    const sb = await connect(h, b);
    await sa.next(presence([a.deviceId, b.deviceId]));
    await sb.next(presence([a.deviceId, b.deviceId]));
    sa.ws.send(JSON.stringify({ t: "msg", to: b.deviceId, d: "Y2lwaGVydGV4dA" }));
    expect(await sb.next((m) => m.t === "msg")).toEqual({ t: "msg", from: a.deviceId, d: "Y2lwaGVydGV4dA" });
    sb.ws.close(1000, "bye");
    await sa.next(presence([a.deviceId]));
    sa.ws.close(1000, "bye");
  });

  it("reports offline devices and rejects frames that are not relay messages", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email);
    const b = await signIn(h, email);
    const sa = await connect(h, a);
    sa.ws.send(JSON.stringify({ t: "msg", to: b.deviceId, d: "abc" }));
    expect(await sa.next((m) => m.t === "error")).toMatchObject({ code: "offline", to: b.deviceId });
    sa.ws.send("not json");
    expect(await sa.next((m) => m.t === "error")).toMatchObject({ code: "bad_frame" });
    sa.ws.send(JSON.stringify({ t: "msg", to: b.deviceId, d: "x".repeat(300_000) }));
    expect(await sa.next((m) => m.t === "error")).toMatchObject({ code: "bad_frame" });
    sa.ws.close(1000, "bye");
  });

  it("never crosses accounts", async () => {
    const h = harness();
    const a = await signIn(h);
    const stranger = await signIn(h);
    const sa = await connect(h, a);
    const ss = await connect(h, stranger);
    sa.ws.send(JSON.stringify({ t: "msg", to: stranger.deviceId, d: "abc" }));
    expect(await sa.next((m) => m.t === "error")).toMatchObject({ code: "offline" });
    sa.ws.close(1000, "bye");
    ss.ws.close(1000, "bye");
  });

  it("closes a revoked device's socket", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email);
    const b = await signIn(h, email);
    const sb = await connect(h, b);
    await h.call("DELETE", `/v1/devices/${b.deviceId}`, { token: a.sessionToken });
    expect((await sb.closed).code).toBe(4001);
  });

  it("replaces an older connection from the same device", async () => {
    const h = harness();
    const a = await signIn(h);
    const first = await connect(h, a);
    const second = await connect(h, a);
    expect((await first.closed).code).toBe(4000);
    second.ws.close(1000, "bye");
  });

  it("slows down a device that floods the relay", async () => {
    const h = harness();
    const email = freshEmail();
    const a = await signIn(h, email);
    const b = await signIn(h, email);
    const sa = await connect(h, a);
    const sb = await connect(h, b);
    for (let i = 0; i < 201; i++) sa.ws.send(JSON.stringify({ t: "msg", to: b.deviceId, d: "abc" }));
    expect(await sa.next((m) => m.t === "error" && m.code === "rate_limited")).toBeTruthy();
    for (let i = 0; i < 200; i++) sa.ws.send(JSON.stringify({ t: "msg", to: b.deviceId, d: "abc" }));
    expect((await sa.closed).code).toBe(4008);
    sb.ws.close(1000, "bye");
  });
});
