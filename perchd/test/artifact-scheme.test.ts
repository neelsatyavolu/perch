import { afterAll, beforeAll, expect, test } from "bun:test";
import { startApp, type App } from "../src/app/app";
import { memoryKeychain } from "../src/app/keychain";
import { Vault } from "../src/app/vault";
import { tempProfile } from "./helpers";

const TOKEN = "t".repeat(43);
const BROWSER = "b".repeat(43);
const dir = tempProfile();
let app: App;

beforeAll(async () => {
  app = await startApp({
    dataDir: dir.dir, vault: await Vault.open(memoryKeychain(), "Default"), runner: async function* () {}, models: [],
    allowedOrigins: ["chrome-untrusted://perch-chat"], token: TOKEN, browserToken: BROWSER, artifactScheme: true,
  });
});
afterAll(async () => {
  await app.stop();
  dir.cleanup();
});

const get = (path: string, token: string) => fetch(`${app.server.url}${path}`, { headers: { authorization: `Bearer ${token}` } });

test("inside Perch artifact addresses are perch-artifact:// with no capability in them", async () => {
  const chat = await app.chats.create({ settings: { mode: "guard", model: "", effort: "medium", scope: "current" } });
  const record = await app.artifacts.save({ chatId: chat.id, title: "Chart", kind: "html", content: "<p>hi</p>" });
  const meta = app.runs.artifactMeta(record);
  expect(meta.url).toBe(`perch-artifact://${record.id}/1`);
  expect(app.info().artifactOrigin).toBe("perch-artifact:");

  const res = await get(`/api/artifact-frames/${record.id}/1`, BROWSER);
  expect(res.status).toBe(200);
  expect(await res.text()).toBe("<p>hi</p>");
  expect(res.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(res.headers.get("content-security-policy")).toContain("connect-src 'none'");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  // Pages can't use the loader's route, and a missing version is not found.
  expect((await get(`/api/artifact-frames/${record.id}/1`, TOKEN)).status).toBe(403);
  expect((await get(`/api/artifact-frames/${record.id}/2`, BROWSER)).status).toBe(404);
});
