/**
 * Image generation for the Image role (spec 7.3): OpenAI Images, Grok Imagine, Gemini (Nano
 * Banana) and ChatGPT sign-in through the Responses image tool. Images are saved in the chat's own
 * folder, mode 0600, and the caller gets their paths.
 */

import { existsSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { openStream, redactSecrets, sseJson, upstreamMessage } from "./http";
import type { ImageApi } from "./providers";
import { ModelError } from "./types";

export type ImageShape = "square" | "landscape" | "portrait";
export type ImageRequest = { prompt: string; folder: string; shape?: ImageShape; count?: number; signal?: AbortSignal };
export type ImageFile = { path: string; mimeType: string; bytes: number };
export type ImageGeneratorOptions = {
  api: ImageApi;
  /** The image model, such as gpt-image-2.5-sunburst. */
  model: string;
  /** For ChatGPT sign-in: the chat model that calls the image tool. */
  hostModel?: string;
  baseUrl: string;
  credential: () => Promise<{ token: string; accountId?: string }>;
  fetch?: typeof fetch;
};

const TIMEOUT_MS = 180_000;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const OPENAI_SIZE: Record<ImageShape, string> = { square: "1024x1024", landscape: "1536x1024", portrait: "1024x1536" };
const ASPECT: Record<ImageShape, string> = { square: "1:1", landscape: "16:9", portrait: "9:16" };

function check(req: ImageRequest): Required<Pick<ImageRequest, "shape" | "count">> {
  if (!req.prompt?.trim()) throw new ModelError("Describe the image to make.");
  if (req.prompt.length > 32_000) throw new ModelError("The image description is too long; keep it under 32,000 characters.");
  if (!isAbsolute(req.folder) || !existsSync(req.folder) || !statSync(req.folder).isDirectory()) throw new ModelError("The chat's folder is missing, so the image has nowhere to go.");
  const count = req.count ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new ModelError("Ask for 1 to 4 images at a time.");
  return { shape: req.shape ?? "square", count };
}

/** The real type comes from the bytes, not from what the provider says. */
function sniff(bytes: Buffer): { mimeType: string; ext: string } | null {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return { mimeType: "image/png", ext: "png" };
  if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return { mimeType: "image/jpeg", ext: "jpg" };
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return { mimeType: "image/webp", ext: "webp" };
  return null;
}

function save(folder: string, images: string[]): ImageFile[] {
  if (!images.length) throw new ModelError("The image model returned no image. Try a different description.");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const decoded = images.map((b64) => Buffer.from(b64, "base64"));
  const typed = decoded.map((bytes) => {
    const type = sniff(bytes);
    if (!type || bytes.length > MAX_IMAGE_BYTES) throw new ModelError("The image model returned something that is not an image.");
    return { bytes, ...type };
  });
  return typed.map(({ bytes, mimeType, ext }, i) => {
    const path = join(folder, `image-${stamp}${typed.length > 1 ? `-${i + 1}` : ""}.${ext}`);
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" });
    return { path, mimeType, bytes: bytes.length };
  });
}

async function postJson(opts: ImageGeneratorOptions, url: string, headers: Record<string, string>, body: object, signal: AbortSignal): Promise<any> {
  let res: Response;
  try {
    res = await (opts.fetch ?? fetch)(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), signal });
  } catch {
    throw new ModelError(signal.aborted ? "Image generation was cancelled or took too long." : "Could not reach the image model. Check your connection.");
  }
  const text = await res.text();
  if (!res.ok) throw new ModelError(upstreamMessage(res.status, text, "Check the image provider's key or sign-in in Settings → Models."), res.status);
  try {
    return JSON.parse(text);
  } catch {
    throw new ModelError("The image model sent a reply Perch could not read.");
  }
}

const b64s = (data: unknown): string[] => (Array.isArray(data) ? data.map((d) => d?.b64_json).filter((s): s is string => typeof s === "string" && s.length > 0) : []);

async function viaCodex(opts: ImageGeneratorOptions, prompt: string, shape: ImageShape, signal: AbortSignal): Promise<string[]> {
  const { token, accountId } = await opts.credential();
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "text/event-stream", originator: "codex_cli_rs", "OpenAI-Beta": "responses=v1" };
  if (accountId) headers["chatgpt-account-id"] = accountId;
  const body = {
    model: opts.hostModel ?? "gpt-6-luna",
    instructions: "Make the image the user describes with the image generation tool. Do not ask questions.",
    input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
    tools: [{ type: "image_generation", model: opts.model, size: OPENAI_SIZE[shape] }],
    tool_choice: { type: "image_generation" },
    store: false,
    stream: true,
  };
  const stream = await openStream(() => ({ url: `${opts.baseUrl.replace(/\/+$/, "")}/responses`, init: { method: "POST", headers, body: JSON.stringify(body) } }), {
    fetch: opts.fetch ?? fetch,
    signal,
    describe: (status, text) => upstreamMessage(status, text, "Sign in to ChatGPT again in Settings → Models."),
  });
  const images: string[] = [];
  for await (const event of sseJson(stream, signal)) {
    if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call" && typeof event.item.result === "string") images.push(event.item.result);
    if (event.type === "response.failed" || event.type === "error") {
      const message = String(event.response?.error?.message ?? event.error?.message ?? "The image model failed.");
      throw new ModelError(redactSecrets(message).split(token).join("[redacted]"));
    }
  }
  return images;
}

export async function generateImages(opts: ImageGeneratorOptions, req: ImageRequest): Promise<ImageFile[]> {
  const { shape, count } = check(req);
  const signal = AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), ...(req.signal ? [req.signal] : [])]);
  const base = opts.baseUrl.replace(/\/+$/, "");
  const prompt = req.prompt.trim();
  if (opts.api === "codex") return save(req.folder, (await viaCodex(opts, prompt, shape, signal)).slice(0, count));
  const { token } = await opts.credential();
  if (opts.api === "openai") {
    const reply = await postJson(opts, `${base}/images/generations`, { authorization: `Bearer ${token}` }, { model: opts.model, prompt, n: count, size: OPENAI_SIZE[shape] }, signal);
    return save(req.folder, b64s(reply?.data));
  }
  if (opts.api === "xai") {
    const body = { model: opts.model, prompt, n: count, response_format: "b64_json", aspect_ratio: ASPECT[shape] };
    const reply = await postJson(opts, `${base}/images/generations`, { authorization: `Bearer ${token}` }, body, signal);
    return save(req.folder, b64s(reply?.data));
  }
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: ASPECT[shape] } } };
  const reply = await postJson(opts, `${base}/models/${encodeURIComponent(opts.model)}:generateContent`, { "x-goog-api-key": token }, body, signal);
  const parts: any[] = (reply?.candidates ?? []).flatMap((c: any) => c?.content?.parts ?? []);
  return save(req.folder, parts.map((p) => p?.inlineData?.data).filter((d): d is string => typeof d === "string").slice(0, count));
}
