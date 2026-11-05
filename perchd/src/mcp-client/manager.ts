/**
 * Keeps the user's enabled MCP servers connected for perchd: asks before a server first runs or is
 * first connected to (and whenever what it runs or where it connects changes), resolves secrets from the Keychain at launch,
 * tracks each server's tools and status, and reconnects a server that went away.
 */

import type { SecretStore } from "../secure/keychain";
import { McpClient, type CallResult, type McpTool } from "./client";
import { connectRemote } from "./http";
import type { RequestOptions } from "./jsonrpc";
import { clientAccount, OAuthProvider, tokenAccount } from "./oauth";
import { findServer, removeServer, updateServer, type RegistryStore } from "./registry";
import { launchFingerprint, launchRequest, type LaunchRequest } from "./launch";
import { resolveConfig, secretAccounts } from "./secrets";
import { StdioTransport } from "./stdio";
import type { ServerEntry } from "./types";

export type { LaunchRequest } from "./launch";

export type ManagerOptions = {
  store: RegistryStore;
  keychain: SecretStore;
  /**
   * Asked before a server first runs (stdio) or is first connected to (remote), and again whenever
   * its command, arguments, env, URL or headers change. Secret values show as ••••.
   */
  approveLaunch: (request: LaunchRequest) => Promise<boolean>;
  /** Opens an OAuth sign-in page for the user (a tab in Perch). */
  openUrl: (url: string) => Promise<void>;
  env?: Record<string, string | undefined>;
  connectTimeoutMs?: number;
  fetch?: typeof fetch;
};

export type ServerState = "connected" | "failed" | "declined" | "off";
export type ServerStatus = { name: string; state: ServerState; tools: number; error?: string };

type Live = { entry: ServerEntry; client: McpClient; tools: McpTool[] };

export class McpManager {
  private live: ReadonlyMap<string, Live> = new Map();
  private statuses: ReadonlyMap<string, ServerStatus> = new Map();
  private readonly listeners: (() => void)[] = [];

  constructor(private readonly opts: ManagerOptions) {}

  /** Connects every enabled server at once; one slow or broken server does not hold up the rest. */
  async start(): Promise<ServerStatus[]> {
    const reg = await this.opts.store.load();
    await Promise.all(reg.servers.map((s) => (s.enabled ? this.connect(s.name) : this.setStatus({ name: s.name, state: "off", tools: 0 }))));
    return this.status();
  }

  status(): ServerStatus[] {
    return [...this.statuses.values()];
  }

  /** Every tool of every connected server. */
  tools(): { server: ServerEntry; tool: McpTool }[] {
    return [...this.live.values()].flatMap((l) => l.tools.map((tool) => ({ server: l.entry, tool })));
  }

  /** Called when any server's tool list changes. */
  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  async connect(name: string): Promise<ServerStatus> {
    const entry = findServer(await this.opts.store.load(), name);
    if (!entry) throw new Error(`no server named "${name}"`);
    await this.disconnect(name);
    try {
      const approved = await this.checkLaunch(entry);
      if (!approved) return this.setStatus({ name, state: "declined", tools: 0, error: "You did not allow this server to run." });
      const client = await this.open(approved);
      const tools = await client.listTools({ timeoutMs: this.opts.connectTimeoutMs ?? 30_000 });
      client.onToolsChanged(() => void this.refresh(name));
      client.onClose((error) => {
        const current = this.live.get(name);
        if (current?.client !== client) return;
        this.live = new Map([...this.live].filter(([k]) => k !== name));
        this.setStatus({ name, state: "failed", tools: 0, ...(error ? { error: error.message } : {}) });
        this.emit();
      });
      this.live = new Map([...this.live, [name, { entry: approved, client, tools }]]);
      this.emit();
      return this.setStatus({ name, state: "connected", tools: tools.length });
    } catch (error) {
      return this.setStatus({ name, state: "failed", tools: 0, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async disconnect(name: string): Promise<void> {
    const current = this.live.get(name);
    if (!current) return;
    this.live = new Map([...this.live].filter(([k]) => k !== name));
    await current.client.close();
    this.emit();
  }

  /** Calls a tool, reconnecting once if the server went away since the last call. */
  async call(server: string, tool: string, args: Record<string, unknown>, opts: RequestOptions = {}): Promise<CallResult> {
    let live = this.live.get(server);
    if (!live || live.client.isClosed) {
      const status = await this.connect(server);
      live = this.live.get(server);
      if (!live) throw new Error(`The MCP server "${server}" is not connected${status.error ? `: ${status.error}` : "."}`);
    }
    return live.client.callTool(tool, args, { timeoutMs: 120_000, ...opts });
  }

  async close(): Promise<void> {
    const all = [...this.live.values()];
    this.live = new Map();
    await Promise.all(all.map((l) => l.client.close()));
  }

  private async checkLaunch(entry: ServerEntry): Promise<ServerEntry | null> {
    const fingerprint = launchFingerprint(entry.config);
    if (entry.approvedLaunch === fingerprint) return entry;
    if (!(await this.opts.approveLaunch(await launchRequest(entry, this.opts.keychain)))) return null;
    await this.opts.store.update((reg) => updateServer(reg, entry.name, { approvedLaunch: fingerprint }));
    return { ...entry, approvedLaunch: fingerprint };
  }

  private async open(entry: ServerEntry): Promise<McpClient> {
    const env = this.opts.env ?? process.env;
    const resolved = await resolveConfig(entry.config, this.opts.keychain, env, entry.name);
    const timeoutMs = this.opts.connectTimeoutMs ?? 30_000;
    if (resolved.transport === "stdio") {
      return McpClient.connect(new StdioTransport({ command: resolved.command, args: resolved.args, env: resolved.env, cwd: resolved.cwd, baseEnv: env }), { timeoutMs });
    }
    const auth = new OAuthProvider({ server: entry.name, serverUrl: resolved.url, keychain: this.opts.keychain, openUrl: this.opts.openUrl, fetch: this.opts.fetch });
    // A configured Authorization header wins; OAuth is only for servers that ask for it.
    const useOAuth = !Object.keys(resolved.headers).some((h) => h.toLowerCase() === "authorization");
    return connectRemote(resolved.transport, { url: resolved.url, headers: resolved.headers, fetch: this.opts.fetch, timeoutMs, ...(useOAuth ? { auth } : {}) });
  }

  private async refresh(name: string): Promise<void> {
    const live = this.live.get(name);
    if (!live) return;
    const tools = await live.client.listTools().catch(() => live.tools);
    this.live = new Map([...this.live, [name, { ...live, tools }]]);
    this.setStatus({ name, state: "connected", tools: tools.length });
    this.emit();
  }

  private setStatus(status: ServerStatus): ServerStatus {
    this.statuses = new Map([...this.statuses, [status.name, status]]);
    return status;
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** Removes a server and every Keychain item that belongs to it (its secrets and OAuth tokens). */
export async function deleteServer(store: RegistryStore, keychain: SecretStore, name: string): Promise<void> {
  let entry: ServerEntry | undefined;
  await store.update((reg) => {
    entry = findServer(reg, name);
    if (!entry) throw new Error(`no server named "${name}"`);
    return removeServer(reg, name);
  });
  await Promise.all([...secretAccounts(entry!.config), tokenAccount(name), clientAccount(name)].map((a) => keychain.delete(a)));
}
