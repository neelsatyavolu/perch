import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { device, freshEmail, harness } from "./helpers";

describe("app", () => {
  it("answers health checks through the real Worker entry", async () => {
    const worker = (exports as unknown as { default: Fetcher }).default;
    const res = await worker.fetch("https://api.perchbrowser.com/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns JSON 404s with security headers and no cookies", async () => {
    const h = harness();
    const { status, data, res } = await h.call("GET", "/nope");
    expect(status).toBe(404);
    expect(data.error.code).toBe("not_found");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("refuses bodies that are not application/json, so cross-site forms cannot post", async () => {
    const h = harness();
    const { status, data } = await h.call("POST", "/v1/auth/email/start", {
      raw: "email=a@b.com",
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(status).toBe(415);
    expect(data.error.code).toBe("unsupported_type");
  });

  it("rejects malformed input with a message naming the field", async () => {
    const h = harness();
    const { status, data } = await h.call("POST", "/v1/auth/email/start", { body: { email: "not-an-email", device: await device() } });
    expect(status).toBe(400);
    expect(data.error.message).toMatch(/email/);
  });

  it("rejects oversized bodies before parsing", async () => {
    const h = harness();
    const { status } = await h.call("POST", "/v1/auth/email/start", { raw: JSON.stringify({ pad: "x".repeat(20_000) }), headers: { "content-type": "application/json" } });
    expect(status).toBe(413);
  });

  it("rate limits sign-in starts per IP with Retry-After", async () => {
    const h = harness();
    const dev = await device();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await h.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: dev } })).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    const last = await h.call("POST", "/v1/auth/email/start", { body: { email: freshEmail(), device: dev } });
    expect(last.status).toBe(429);
    expect(Number(last.res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
