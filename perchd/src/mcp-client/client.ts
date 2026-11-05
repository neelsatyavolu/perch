/** One connection to an MCP server: initialize, list tools (all pages), call tools. */

import { RpcSession, type RequestOptions, type Transport } from "./jsonrpc";

export const PROTOCOL_VERSION = "2025-06-18";
const SUPPORTED = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);
const CLIENT_INFO = { name: "perch", title: "Perch", version: "0.1.0" };
const MAX_PAGES = 20;
const MAX_TOOLS = 500;

export type ToolAnnotations = { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
export type McpTool = { name: string; title?: string; description: string; inputSchema: Record<string, unknown>; annotations: ToolAnnotations };

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string };
export type CallResult = { content: ContentBlock[]; isError: boolean; structuredContent?: unknown };

export type ServerInfo = { name: string; version?: string; title?: string };

function parseTool(raw: unknown): McpTool | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  if (typeof t.name !== "string" || !t.name) return null;
  const schema = t.inputSchema && typeof t.inputSchema === "object" && !Array.isArray(t.inputSchema) ? (t.inputSchema as Record<string, unknown>) : { type: "object" };
  const a = (t.annotations && typeof t.annotations === "object" ? t.annotations : {}) as Record<string, unknown>;
  const bool = (v: unknown) => (typeof v === "boolean" ? v : undefined);
  return {
    name: t.name,
    ...(typeof t.title === "string" ? { title: t.title } : {}),
    description: typeof t.description === "string" ? t.description : "",
    inputSchema: { ...schema, type: "object" },
    annotations: {
      ...(typeof a.title === "string" ? { title: a.title } : {}),
      readOnlyHint: bool(a.readOnlyHint),
      destructiveHint: bool(a.destructiveHint),
      idempotentHint: bool(a.idempotentHint),
      openWorldHint: bool(a.openWorldHint),
    },
  };
}

export class McpClient {
  private constructor(
    private readonly session: RpcSession,
    readonly protocolVersion: string,
    readonly serverInfo: ServerInfo,
    readonly instructions: string,
    readonly hasTools: boolean,
  ) {}

  static async connect(transport: Transport, opts: { timeoutMs?: number } = {}): Promise<McpClient> {
    const session = new RpcSession(transport);
    await session.start();
    try {
      const init = await session.request<Record<string, any>>(
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        { timeoutMs: opts.timeoutMs ?? 30_000 },
      );
      const version = String(init?.protocolVersion ?? "");
      if (!SUPPORTED.has(version)) throw new Error(`The server speaks MCP version "${version.slice(0, 20)}", which Perch does not support.`);
      transport.setProtocolVersion?.(version);
      await session.notify("notifications/initialized");
      const info = init.serverInfo && typeof init.serverInfo.name === "string" ? init.serverInfo : { name: "unknown" };
      const instructions = typeof init.instructions === "string" ? init.instructions.slice(0, 4000) : "";
      return new McpClient(session, version, info, instructions, Boolean(init.capabilities?.tools));
    } catch (error) {
      await session.close();
      throw error;
    }
  }

  get isClosed(): boolean {
    return this.session.isClosed;
  }

  onToolsChanged(handler: () => void): void {
    this.session.onNotification((method) => {
      if (method === "notifications/tools/list_changed") handler();
    });
  }

  onClose(handler: (error?: Error) => void): void {
    this.session.onClose(handler);
  }

  async listTools(opts: RequestOptions = {}): Promise<McpTool[]> {
    if (!this.hasTools) return [];
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const res = await this.session.request<{ tools?: unknown[]; nextCursor?: unknown }>("tools/list", cursor ? { cursor } : {}, opts);
      for (const raw of res?.tools ?? []) {
        const tool = parseTool(raw);
        if (tool && tools.length < MAX_TOOLS) tools.push(tool);
      }
      cursor = typeof res?.nextCursor === "string" && res.nextCursor ? res.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  async callTool(name: string, args: Record<string, unknown>, opts: RequestOptions = {}): Promise<CallResult> {
    const res = await this.session.request<Record<string, unknown>>("tools/call", { name, arguments: args }, opts);
    const content = Array.isArray(res?.content) ? (res.content as ContentBlock[]).filter((c) => c && typeof c === "object" && typeof c.type === "string") : [];
    return { content, isError: res?.isError === true, ...(res?.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}) };
  }

  close(): Promise<void> {
    return this.session.close();
  }
}
