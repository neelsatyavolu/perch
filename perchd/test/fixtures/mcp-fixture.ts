/**
 * A tiny MCP server for tests, shared by the stdio and HTTP fixtures. handle() returns every
 * message the server sends in answer: notifications first, then the reply.
 */

type Msg = { jsonrpc: "2.0"; id?: number | string | null; method?: string; params?: any; result?: any; error?: any };

export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const BASE_TOOLS = [
  { name: "echo", description: "Repeat the text.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
  { name: "add_note", description: "Save a note.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  { name: "delete_all", description: "Delete every note.", inputSchema: { type: "object", properties: {} }, annotations: { destructiveHint: true } },
  { name: "slow", description: "Wait, then answer.", inputSchema: { type: "object", properties: { ms: { type: "number" } } }, annotations: { readOnlyHint: true } },
  { name: "env_value", description: "Read an environment variable.", inputSchema: { type: "object", properties: { name: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "picture", description: "Return a picture.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "broken", description: "Always fails.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "grow", description: "Add a tool.", inputSchema: { type: "object", properties: {} } },
  { name: "big", description: "Return a lot of text.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];
const PAGE = 4;

export function createFixture(opts: { env?: Record<string, string | undefined> } = {}) {
  let tools = [...BASE_TOOLS];
  const notes: string[] = [];
  const cancelled = new Set<string | number>();
  const reply = (id: Msg["id"], result: unknown): Msg => ({ jsonrpc: "2.0", id, result });
  const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

  async function call(msg: Msg): Promise<Msg[]> {
    const { name, arguments: args = {} } = msg.params ?? {};
    switch (name) {
      case "echo": return [reply(msg.id, text(String(args.text)))];
      case "add_note": notes.push(String(args.note)); return [reply(msg.id, text(`saved (${notes.length} notes)`))];
      case "delete_all": notes.length = 0; return [reply(msg.id, text("deleted"))];
      case "slow": {
        const until = Date.now() + Number(args.ms ?? 100);
        while (Date.now() < until) {
          if (cancelled.has(msg.id!)) return [];
          await Bun.sleep(10);
        }
        return [reply(msg.id, text("finally"))];
      }
      case "env_value": return [reply(msg.id, text(String(opts.env?.[String(args.name)] ?? "(unset)")))];
      case "picture": return [reply(msg.id, { content: [{ type: "text", text: "a dot" }, { type: "image", data: PNG_1PX, mimeType: "image/png" }] })];
      case "broken": return [reply(msg.id, text("the tool failed on purpose", true))];
      case "big": return [reply(msg.id, text("x".repeat(50_000)))];
      case "grow":
        tools = [...tools, { name: "extra", description: "Added later.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }];
        return [{ jsonrpc: "2.0", method: "notifications/tools/list_changed" }, reply(msg.id, text("grown"))];
      default: return [{ jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `unknown tool ${name}` } }];
    }
  }

  async function handle(msg: Msg): Promise<Msg[]> {
    if (msg.method === "notifications/cancelled") cancelled.add(msg.params?.requestId);
    if (msg.id === undefined || msg.id === null || !msg.method) return [];
    switch (msg.method) {
      case "initialize":
        return [reply(msg.id, { protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fixture", version: "1.0.0" }, instructions: "Fixture server." })];
      case "ping": return [reply(msg.id, {})];
      case "tools/list": {
        const start = Number(msg.params?.cursor ?? 0);
        const next = start + PAGE < tools.length ? String(start + PAGE) : undefined;
        return [reply(msg.id, { tools: tools.slice(start, start + PAGE), ...(next ? { nextCursor: next } : {}) })];
      }
      case "tools/call": return call(msg);
      default: return [{ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } }];
    }
  }

  return { handle, notes: () => [...notes] };
}
