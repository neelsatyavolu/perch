import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Browser } from "../src/browser/browser";
import { clientFromInfo, runMcp } from "../src/cli/mcp-proxy";
import { startDaemon, type Daemon } from "../src/daemon/daemon";
import { MemoryKeychain } from "../src/daemon/keychain";
import { perchPaths } from "../src/daemon/paths";
import { startFixtures } from "./fixtures/server";
import { tempProfile } from "./helpers";

const home = tempProfile();
const profile = tempProfile();
const site = startFixtures();
const keychain = new MemoryKeychain();
const paths = perchPaths({ PERCH_HOME: home.dir });
let daemon: Daemon;

beforeAll(async () => {
  daemon = await startDaemon({ paths, keychain, launch: () => Browser.launch({ userDataDir: profile.dir }), graceMs: 50 });
});
afterAll(async () => {
  await daemon.stop();
  site.stop();
  home.cleanup();
  profile.cleanup();
});

/** An MCP client on the other end of `perch mcp`, in this process. */
function mcpClient(argv: string[], answer: (request: any) => object | null = () => null) {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  const waiting = new Map<number, (msg: any) => void>();
  let nextId = 1;
  const push = (msg: object) => {
    queue.push(JSON.stringify(msg));
    wake?.();
  };
  async function* lines() {
    for (;;) {
      while (queue.length) yield queue.shift()!;
      if (ended) return;
      await new Promise<void>((r) => (wake = r));
    }
  }
  const done = runMcp(argv, { env: { PERCH_HOME: home.dir }, cwd: "/work/perch", keychain, stdout: () => {}, stderr: () => {}, autostart: false }, {
    lines: lines(),
    write: (line) => {
      const msg = JSON.parse(line);
      if (msg.method) {
        const reply = answer(msg);
        if (reply) push({ jsonrpc: "2.0", id: msg.id, result: reply });
        return;
      }
      waiting.get(msg.id)?.(msg);
    },
  });
  return {
    rpc(method: string, params: object = {}): Promise<any> {
      const id = nextId++;
      push({ jsonrpc: "2.0", id, method, params });
      return new Promise((resolve) => waiting.set(id, resolve));
    },
    async end() {
      ended = true;
      wake?.();
      await done;
    },
  };
}

test("client names come from the MCP client's own name", () => {
  expect(clientFromInfo("claude-code")).toBe("claude-code");
  expect(clientFromInfo("codex-mcp-client")).toBe("codex");
  expect(clientFromInfo("Grok CLI")).toBe("grok-cli");
  expect(clientFromInfo(undefined)).toBe("mcp");
});

test("Claude Code gets its own labelled session, and approvals arrive as elicitation", async () => {
  const asked: string[] = [];
  const c = mcpClient(["--session", "tab-1"], (req) => (req.method === "elicitation/create" ? (asked.push(req.params.message), { action: "accept" }) : null));
  const init = await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { elicitation: {} }, clientInfo: { name: "claude-code", version: "3" } });
  expect(init.result.serverInfo.name).toBe("perch");
  const list = await c.rpc("tools/list");
  expect(list.result.tools.map((t: { name: string }) => t.name)).toContain("click");

  const page = await c.rpc("tools/call", { name: "navigate", arguments: { url: site.url("/mail.html") } });
  const compose = page.result.content[0].text.match(/button "Compose" \[ref=(e\d+)\]/)[1];
  const opened = await c.rpc("tools/call", { name: "click", arguments: { ref: compose } });
  const send = opened.result.content[0].text.match(/button "Send" \[ref=(e\d+)\]/)[1];
  const sent = await c.rpc("tools/call", { name: "click", arguments: { ref: send } });
  expect(sent.result.isError).toBe(false);
  expect(asked).toEqual([expect.stringContaining('Click button "Send"')]);

  const file = JSON.parse(readFileSync(paths.sessionsFile, "utf8"));
  expect(file.sessions).toContainEqual(expect.objectContaining({ client: "claude-code", session: "tab-1", label: "Claude Code · perch", tabs: 1 }));

  await c.end();
  await Bun.sleep(300);
  expect(daemon.manager.get("claude-code", "tab-1")).toBeUndefined();
}, 60_000);

test("a client that cannot show approvals has risky actions declined", async () => {
  const c = mcpClient(["--client", "agterm", "--session", "T2", "--agent", "codex", "--title", "Docs"]);
  await c.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "1" } });
  const page = await c.rpc("tools/call", { name: "navigate", arguments: { url: site.url("/mail.html") } });
  const compose = page.result.content[0].text.match(/button "Compose" \[ref=(e\d+)\]/)[1];
  const opened = await c.rpc("tools/call", { name: "click", arguments: { ref: compose } });
  const send = opened.result.content[0].text.match(/button "Send" \[ref=(e\d+)\]/)[1];
  const sent = await c.rpc("tools/call", { name: "click", arguments: { ref: send } });
  expect(sent.result.content[0].text).toBe("The user declined this action. Do not try it again; ask or finish.");
  expect(daemon.manager.get("agterm", "T2")?.label).toBe("Codex · Docs");
  const unknown = await c.rpc("resources/list");
  expect(unknown.error.code).toBe(-32601);
  await c.end();
}, 60_000);
