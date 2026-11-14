import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startApp, type App } from "../src/app/app";
import { memoryKeychain } from "../src/app/keychain";
import type { RunnerInput } from "../src/app/runs";
import { Vault } from "../src/app/vault";
import { tempProfile } from "./helpers";

const TOKEN = "t".repeat(43);
const BROWSER = "b".repeat(43);
const dir = tempProfile();
const inputs: RunnerInput[] = [];
let app: App;

beforeAll(async () => {
  app = await startApp({
    dataDir: join(dir.dir, "app"), vault: await Vault.open(memoryKeychain(), "Default"), models: [{ id: "fake", label: "Fake", provider: "Test", efforts: ["medium"] }],
    runner: async function* (input) {
      inputs.push(input);
      yield { type: "final", text: "ok" };
    },
    allowedOrigins: [], token: TOKEN, browserToken: BROWSER,
  });
});
afterAll(async () => {
  await app.stop();
  dir.cleanup();
});

const call = (method: string, path: string, token: string, body?: unknown) =>
  fetch(`${app.server.url}${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });

test("the browser registers picked files; pages get ids, and the task gets the paths", async () => {
  const file = join(dir.dir, "notes.txt");
  writeFileSync(file, "hello");
  expect((await call("POST", "/api/files", TOKEN, { paths: [file] })).status).toBe(403);
  expect((await call("POST", "/api/files", BROWSER, { paths: ["relative.txt"] })).status).toBe(400);
  expect((await call("POST", "/api/files", BROWSER, { paths: [join(dir.dir, "missing.txt")] })).status).toBe(400);
  const { files } = (await (await call("POST", "/api/files", BROWSER, { paths: [file] })).json()) as { files: { id: string; name: string; size: number }[] };
  expect(files).toEqual([{ id: expect.any(String), name: "notes.txt", size: 5 }]);
  expect(JSON.stringify(files)).not.toContain(dir.dir);

  await call("PUT", "/api/tabs", BROWSER, { tabs: [{ id: "guid-1", windowId: "w1", title: "Flights", url: "https://flights.example/", targetId: "T1" }] });
  const tabs = (await (await call("GET", "/api/tabs", TOKEN)).json()) as object[];
  expect(tabs).toEqual([{ id: "guid-1", windowId: "w1", title: "Flights", url: "https://flights.example/" }]);

  const chat = (await (await call("POST", "/api/chats", TOKEN, {})).json()) as { id: string };
  const sent = await call("POST", `/api/chats/${chat.id}/messages`, TOKEN, { text: "use these", files: [files[0]!.id], mentions: ["guid-1"] });
  expect(sent.status).toBe(200);
  const { message } = (await sent.json()) as { message: { attachments: unknown; mentions: unknown } };
  expect(message.attachments).toEqual([{ id: files[0]!.id, name: "notes.txt" }]);
  expect(message.mentions).toEqual([{ id: "guid-1", windowId: "w1", title: "Flights", url: "https://flights.example/" }]);
  await app.runs.idle();
  expect(inputs[0]!.task).toContain(file);
  expect(inputs[0]!.task).toContain("https://flights.example/");

  expect((await call("POST", `/api/chats/${chat.id}/messages`, TOKEN, { text: "x", files: ["no-such-id"] })).status).toBe(404);
  expect((await call("POST", `/api/chats/${chat.id}/messages`, TOKEN, { text: "x", mentions: ["closed-tab"] })).status).toBe(400);
});

test("an image pasted into the chat is stored privately, attached by id, and has a preview", async () => {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const res = await call("POST", "/api/files/paste", TOKEN, { name: "../Screen Shot.png", data: png.toString("base64") });
  const { file } = (await res.json()) as { file: { id: string; name: string; size: number } };
  expect(file).toEqual({ id: expect.any(String), name: "Screen Shot.png", size: png.length });
  const preview = await call("GET", `/api/files/${file.id}/preview`, TOKEN);
  expect(preview.headers.get("content-type")).toBe("image/png");
  expect(Buffer.from(await preview.arrayBuffer())).toEqual(png);
  // The stored copy is readable by this user only, and the task sees its path.
  const { statSync } = await import("node:fs");
  const chat = (await (await call("POST", "/api/chats", TOKEN, {})).json()) as { id: string };
  expect((await call("POST", `/api/chats/${chat.id}/messages`, TOKEN, { text: "what's this?", files: [file.id] })).status).toBe(200);
  await app.runs.idle();
  const path = inputs.at(-1)!.task.match(/\/\S*perch-pasted-\S*Screen Shot\.png/)?.[0] ?? inputs.at(-1)!.task.match(/(\/[^\n]*perch-pasted-[^\n]*?Screen Shot\.png)/)?.[1];
  expect(path).toBeDefined();
  expect(statSync(path!).mode & 0o777).toBe(0o600);
  expect(statSync(join(path!, "..", "..")).mode & 0o777).toBe(0o700);

  expect((await call("POST", "/api/files/paste", TOKEN, { name: "x.txt", data: "not base64!" })).status).toBe(400);
  const text = (await (await call("POST", "/api/files/paste", TOKEN, { name: "notes.txt", data: Buffer.from("hi").toString("base64") })).json()) as { file: { id: string } };
  expect((await call("GET", `/api/files/${text.file.id}/preview`, TOKEN)).status).toBe(404);
});
