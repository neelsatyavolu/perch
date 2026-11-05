import { afterEach, expect, test } from "bun:test";
import { fetchModelList } from "../src/models/connection";
import { fakeServer, json, type FakeServer } from "./fixtures/fake-providers";

let server: FakeServer | null = null;
afterEach(() => server?.stop());

const routes = (keyStatus: number) =>
  fakeServer((req) => (req.path === "/api/v1/key" ? json({ data: {} }, keyStatus) : json({ data: [{ id: "acme/one", supported_parameters: ["tools"] }] })));

test("OpenRouter's key is checked on its own endpoint, since its model list is public", async () => {
  server = routes(401);
  await expect(fetchModelList({ provider: "openrouter", baseUrl: `${server.url}/api/v1`, credential: "sk-or-bad-0123456789", fetch })).rejects.toThrow("OpenRouter rejected that key");
  expect(server.seen.map((s) => s.path)).toEqual(["/api/v1/key"]);
});

test("a good OpenRouter key lists models", async () => {
  server = routes(200);
  const models = await fetchModelList({ provider: "openrouter", baseUrl: `${server.url}/api/v1`, credential: "sk-or-good-0123456789", fetch });
  expect(models.map((m) => m.id)).toEqual(["acme/one"]);
  expect(server.seen[0]!.headers.authorization).toBe("Bearer sk-or-good-0123456789");
});

test("a server that answers with HTML is reported as unreadable", async () => {
  server = fakeServer(() => new Response("<html>login</html>", { headers: { "content-type": "text/html" } }));
  await expect(fetchModelList({ provider: "custom", baseUrl: server.url, credential: null, fetch })).rejects.toThrow("could not read");
});

test("a gateway error names the provider and hides keys in its message", async () => {
  server = fakeServer(() => json({ error: { message: "upstream failed for key sk-live-0123456789abcdef" } }, 502));
  const error = await fetchModelList({ provider: "custom", baseUrl: server.url, credential: null, fetch }).catch((e: Error) => e);
  expect(String(error)).toContain("OpenAI-compatible endpoint answered with an error (HTTP 502)");
  expect(String(error)).not.toContain("sk-live");
});
