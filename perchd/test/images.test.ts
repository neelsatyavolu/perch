import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { generateImages } from "../src/models/images";
import { fakeServer, json, PNG_1PX, sse, type FakeServer } from "./fixtures/fake-providers";
import { tempProfile } from "./helpers";

let server: FakeServer | null = null;
const cleanups: (() => void)[] = [];
afterEach(() => {
  server?.stop();
  cleanups.splice(0).forEach((c) => c());
});
function folder(): string {
  const { dir, cleanup } = tempProfile();
  cleanups.push(cleanup);
  return dir;
}
const JPEG_B64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]).toString("base64");

test("OpenAI Images: request shape, PNG files saved in the chat folder", async () => {
  server = fakeServer(() => json({ data: [{ b64_json: PNG_1PX }, { b64_json: PNG_1PX }] }));
  const dir = folder();
  const files = await generateImages(
    { api: "openai", model: "gpt-image-2.5-sunburst", baseUrl: `${server.url}/v1`, credential: async () => ({ token: "sk-img-0123456789abcdef" }) },
    { prompt: "A lighthouse at dawn", folder: dir, shape: "landscape", count: 2 },
  );
  const req = server.seen[0]!;
  expect(req.path).toBe("/v1/images/generations");
  expect(req.headers.authorization).toBe("Bearer sk-img-0123456789abcdef");
  expect(req.body).toEqual({ model: "gpt-image-2.5-sunburst", prompt: "A lighthouse at dawn", n: 2, size: "1536x1024" });
  expect(files).toHaveLength(2);
  for (const f of files) {
    expect(f.path.startsWith(dir)).toBe(true);
    expect(f.mimeType).toBe("image/png");
    expect(f.path.endsWith(".png")).toBe(true);
    expect(statSync(f.path).mode & 0o777).toBe(0o600);
  }
  expect(readFileSync(files[0]!.path).toString("base64")).toBe(PNG_1PX);
});

test("Grok Imagine: base64 response format, aspect ratio, type found from the bytes", async () => {
  server = fakeServer(() => json({ data: [{ b64_json: JPEG_B64 }] }));
  const files = await generateImages(
    { api: "xai", model: "grok-imagine-image-2.0", baseUrl: `${server.url}/v1`, credential: async () => ({ token: "xai-0123456789abcdef" }) },
    { prompt: "A fox", folder: folder(), shape: "portrait" },
  );
  expect(server.seen[0]!.body).toEqual({ model: "grok-imagine-image-2.0", prompt: "A fox", n: 1, response_format: "b64_json", aspect_ratio: "9:16" });
  expect(files[0]!.mimeType).toBe("image/jpeg");
  expect(files[0]!.path.endsWith(".jpg")).toBe(true);
});

test("Gemini: generateContent with image output, key in a header not the URL", async () => {
  server = fakeServer(() => json({ candidates: [{ content: { parts: [{ text: "Here it is." }, { inlineData: { mimeType: "image/png", data: PNG_1PX } }] } }] }));
  const files = await generateImages(
    { api: "gemini", model: "gemini-nano-banana-2.1", baseUrl: `${server.url}/v1beta`, credential: async () => ({ token: "AIza0123456789abcdef" }) },
    { prompt: "A cat", folder: folder() },
  );
  const req = server.seen[0]!;
  expect(req.path).toBe("/v1beta/models/gemini-nano-banana-2.1:generateContent");
  expect(req.search).toBe("");
  expect(req.headers["x-goog-api-key"]).toBe("AIza0123456789abcdef");
  expect(req.body).toEqual({ contents: [{ role: "user", parts: [{ text: "A cat" }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { aspectRatio: "1:1" } } });
  expect(files).toHaveLength(1);
});

test("ChatGPT sign-in: the Responses image tool, results read from the stream", async () => {
  server = fakeServer(() =>
    sse([
      { type: "response.output_item.done", item: { type: "image_generation_call", result: PNG_1PX } },
      { type: "response.completed", response: {} },
    ]),
  );
  const files = await generateImages(
    { api: "codex", model: "gpt-image-2.5-sunburst", hostModel: "gpt-6-luna", baseUrl: server.url, credential: async () => ({ token: "acc-tok-0123456789", accountId: "org-9" }) },
    { prompt: "A boat", folder: folder() },
  );
  const req = server.seen[0]!;
  expect(req.path).toBe("/responses");
  expect(req.headers["chatgpt-account-id"]).toBe("org-9");
  expect(req.body).toMatchObject({ model: "gpt-6-luna", stream: true, store: false, tools: [{ type: "image_generation", model: "gpt-image-2.5-sunburst", size: "1024x1024" }] });
  expect(req.body.input[0].content[0].text).toBe("A boat");
  expect(files).toHaveLength(1);
});

test("errors are plain and never repeat the key; nothing is written", async () => {
  server = fakeServer(() => json({ error: { message: "Your request was rejected by the safety system. key sk-img-0123456789abcdef" } }, 400));
  const dir = folder();
  const error = await generateImages(
    { api: "openai", model: "gpt-image-2.5-sunburst", baseUrl: server.url, credential: async () => ({ token: "sk-img-0123456789abcdef" }) },
    { prompt: "x", folder: dir },
  ).catch((e: Error) => e);
  expect(String(error)).toContain("rejected by the safety system");
  expect(String(error)).not.toContain("sk-img-0123456789abcdef");
  expect(readdirSync(dir)).toEqual([]);
});

test("bad input is refused before any request", async () => {
  server = fakeServer(() => json({}));
  const gen = { api: "openai" as const, model: "m", baseUrl: server.url, credential: async () => ({ token: "t" }) };
  await expect(generateImages(gen, { prompt: "  ", folder: folder() })).rejects.toThrow("Describe the image");
  await expect(generateImages(gen, { prompt: "x", folder: "relative/dir" })).rejects.toThrow("folder");
  await expect(generateImages(gen, { prompt: "x", folder: folder(), count: 9 })).rejects.toThrow("1 to 4");
  await expect(generateImages(gen, { prompt: "x", folder: join(folder(), "missing") })).rejects.toThrow("folder");
  expect(server.seen).toHaveLength(0);
});

test("a reply with no image says so", async () => {
  server = fakeServer(() => json({ data: [] }));
  await expect(
    generateImages({ api: "xai", model: "m", baseUrl: server.url, credential: async () => ({ token: "t" }) }, { prompt: "x", folder: folder() }),
  ).rejects.toThrow("no image");
});
