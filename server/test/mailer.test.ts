import { describe, expect, it } from "vitest";
import { exports } from "cloudflare:workers";
import { disabledMailer, resendMailer } from "../src/mailer";
import { HttpError } from "../src/http";
import { device, freshEmail, freshIp } from "./helpers";

const message = { to: "a@example.com", subject: "Sign in to Perch", text: "t", html: "<p>t</p>" };

describe("mailers", () => {
  it("sends through Resend with the key in the Authorization header only", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    await resendMailer("re_test_fake", "Perch <sign-in@perchbrowser.com>", fake).send(message);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer re_test_fake");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      from: "Perch <sign-in@perchbrowser.com>", to: ["a@example.com"], subject: message.subject, text: "t", html: "<p>t</p>",
    });
  });

  it("turns a Resend failure into a plain 502", async () => {
    const fake = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    const error = await resendMailer("re_test_fake", "x", fake).send(message).catch((e) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error.status).toBe(502);
  });

  it("without a Resend key the real Worker refuses email sign-in and points to passkeys", async () => {
    await expect(disabledMailer.send(message)).rejects.toMatchObject({ status: 503 });
    const worker = (exports as unknown as { default: Fetcher }).default;
    const res = await worker.fetch("https://api.perchbrowser.com/v1/auth/email/start", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() },
      body: JSON.stringify({ email: freshEmail(), device: await device() }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).error.message).toContain("passkey");
  });
});
