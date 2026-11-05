/** Opening a streaming model request with retries, and reading its server-sent events. */

import { ModelError } from "./types";

const MAX_ATTEMPTS = 4;
const RETRY_MS = 800;
/** Reasoning models can think silently for minutes before the first event. */
export const IDLE_MS = 300_000;

export type Attempt = { url: string; init: RequestInit };

/** Retries 429, 5xx and network failures; `adjust` may return a changed attempt for a 400. */
export async function openStream(
  build: () => Attempt,
  opts: { fetch: typeof fetch; signal: AbortSignal; describe: (status: number, text: string) => string; adjust?: (text: string) => boolean },
): Promise<ReadableStream<Uint8Array>> {
  let failure = new ModelError("The model request failed.");
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (opts.signal.aborted) throw new ModelError("Cancelled.");
    const { url, init } = build();
    let res: Response;
    try {
      res = await opts.fetch(url, { ...init, signal: opts.signal });
    } catch {
      if (opts.signal.aborted) throw new ModelError("Cancelled.");
      failure = new ModelError("Could not reach the model. Check your connection.");
      await Bun.sleep(RETRY_MS * (attempt + 1));
      continue;
    }
    if (res.ok && res.body) return res.body;
    const text = await res.text().catch(() => "");
    failure = new ModelError(opts.describe(res.status, text), res.status);
    if (res.status === 400 && opts.adjust?.(text)) continue;
    if (res.status === 429 || res.status >= 500) {
      await Bun.sleep(RETRY_MS * (attempt + 1));
      continue;
    }
    break;
  }
  throw failure;
}

/** Yields each SSE `data:` payload, parsed as JSON. Gives up after five minutes of silence. */
export async function* sseJson(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncIterable<any> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const abort = () => reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      let idle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        idle = setTimeout(() => reject(new ModelError("The model stopped responding.")), IDLE_MS);
      });
      const { value, done } = await Promise.race([reader.read(), timeout]).finally(() => clearTimeout(idle));
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const block = buffer.slice(0, split);
        buffer = buffer.slice(split).replace(/^\r?\n\r?\n/, "");
        const data = block.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data);
        } catch {
          // Ignore keep-alive comments and malformed lines.
        }
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (signal.aborted) throw new ModelError("Cancelled.");
}

/** Hides anything shaped like an API key or token (OpenAI, Anthropic, OpenRouter, xAI, Google, JWTs). */
export function redactSecrets(text: string): string {
  return text.replace(/\b(sk|tok|eyJ|xai|AIza|ya29)[\w.-]{8,}/g, "[redacted]");
}

/** A provider's error message, without echoing anything that looks like a credential. */
export function upstreamMessage(status: number, text: string, signInHint: string): string {
  if (status === 401 || status === 403) return signInHint;
  if (status === 429) return "The model's rate limit was hit. Try again in a moment.";
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown }; detail?: unknown; message?: unknown };
    const message = json?.error?.message ?? json?.detail ?? json?.message;
    if (typeof message === "string" && message) return redactSecrets(message);
  } catch {
    /* not JSON */
  }
  return `The model request failed (HTTP ${status}).`;
}
