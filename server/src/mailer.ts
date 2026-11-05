import type { AppEnv, Mailer } from "./env";
import { HttpError } from "./http";
import { logEvent } from "./log";

/** Sends through Resend's HTTP API. The key comes from a Worker secret. */
export function resendMailer(apiKey: string, from: string, fetcher: typeof fetch = fetch): Mailer {
  return {
    async send(message) {
      const response = await fetcher("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [message.to], subject: message.subject, text: message.text, html: message.html }),
      });
      if (!response.ok) {
        logEvent("mail_failed", { status: response.status });
        throw new HttpError(502, "mail_failed", "The sign-in email could not be sent. Try again in a minute.");
      }
    },
  };
}

/** Used when no mail provider is set up: sign-in by email is refused, and nothing is logged. */
export const disabledMailer: Mailer = {
  async send() {
    throw new HttpError(503, "mail_disabled", "Email sign-in is not set up on this server. Sign in with a passkey.");
  },
};

export const mailerFromEnv = (env: AppEnv): Mailer =>
  env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY, env.MAIL_FROM) : disabledMailer;

export type CapturedMail = { to: string; subject: string; text: string; html: string };

/** For tests: keeps messages in memory instead of sending them. */
export function captureMailer(): Mailer & { sent: CapturedMail[] } {
  const sent: CapturedMail[] = [];
  return {
    sent,
    async send(message) {
      sent.push({ ...message });
    },
  };
}
