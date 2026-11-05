import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startFixtures } from "./fixtures/server";
import { tempProfile } from "./helpers";

const site = startFixtures();
const profile = tempProfile();
let proc: ReturnType<typeof Bun.spawn>;
let buffer = "";
const waiting = new Map<number, (msg: any) => void>();
let nextId = 1;

function rpc(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  (proc.stdin as import("bun").FileSink).write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", "run", join(import.meta.dir, "../src/mcp.ts"), "--profile", profile.dir, "--audit", join(profile.dir, "audit.jsonl")], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  (async () => {
    const decoder = new TextDecoder();
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(chunk);
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        waiting.get(msg.id)?.(msg);
      }
    }
  })();
});
afterAll(() => {
  proc.kill();
  site.stop();
  profile.cleanup();
});

test("initialize and list the browser tools", async () => {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
  expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "perch" } });
  (proc.stdin as import("bun").FileSink).write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const list = await rpc("tools/list");
  const names = list.result.tools.map((t: { name: string }) => t.name);
  expect(names).toContain("navigate");
  expect(names).toContain("snapshot");
  expect(names).not.toContain("done");
  expect(list.result.tools[0].inputSchema.type).toBe("object");
});

test("tool calls run in the browser and errors come back as tool errors", async () => {
  const opened = await rpc("tools/call", { name: "navigate", arguments: { url: site.url("/mail.html") } });
  expect(opened.result.isError).toBeFalsy();
  expect(opened.result.content[0].text).toContain('button "Compose"');
  const bad = await rpc("tools/call", { name: "navigate", arguments: { url: "javascript:alert(1)" } });
  expect(bad.result).toMatchObject({ isError: true, content: [{ type: "text", text: "Perch's agent only opens http and https pages" }] });
  const shot = await rpc("tools/call", { name: "screenshot", arguments: {} });
  expect(shot.result.content.some((c: { type: string }) => c.type === "image")).toBe(true);
}, 30_000);

test("risky actions are declined without an approval UI, and unknown methods fail", async () => {
  const page = await rpc("tools/call", { name: "navigate", arguments: { url: site.url("/far.html") } });
  void page;
  const full = await rpc("tools/call", { name: "snapshot", arguments: { full: true } });
  const ref = full.result.content[0].text.match(/button "Send" \[ref=(e\d+)\]/)[1];
  const sent = await rpc("tools/call", { name: "click", arguments: { ref } });
  expect(sent.result.content[0].text).toBe("The user declined this action. Do not try it again; ask or finish.");
  const unknown = await rpc("resources/list");
  expect(unknown.error.code).toBe(-32601);
}, 30_000);
