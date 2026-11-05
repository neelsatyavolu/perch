/**
 * Everything beyond the browser that a task can use: the user's MCP servers (connected through
 * McpManager, asking before a server first runs) and skills (built-in and the user's own).
 */

import { join } from "node:path";
import type { SecretStore } from "../secure/keychain";
import { SkillCatalog } from "../skills/catalog";
import { SkillStore } from "../skills/store";
import { skillExtraTools } from "../skills/tool";
import { mcpExtraTools } from "./agent-tools";
import { combineExtraTools, type ExtraTools } from "./extra-tools";
import { McpManager, type ManagerOptions, type ServerStatus } from "./manager";
import { RegistryStore } from "./registry";

/** Where Perch keeps its settings: the encrypted server list and the user's skills. */
export const settingsDir = (home: string) => join(home, "Library", "Application Support", "Perch");

export type AgentExtrasOptions = Pick<ManagerOptions, "approveLaunch" | "openUrl" | "env" | "fetch"> & { dir: string; keychain: SecretStore; builtInSkillsDir?: string };

export type AgentExtras = { extraTools: ExtraTools; status: ServerStatus[]; close: () => Promise<void> };

export async function loadAgentExtras(opts: AgentExtrasOptions): Promise<AgentExtras> {
  const manager = new McpManager({ ...opts, store: new RegistryStore(join(opts.dir, "mcp-servers.enc"), opts.keychain) });
  const [status, catalog] = await Promise.all([manager.start(), SkillCatalog.load({ store: new SkillStore(join(opts.dir, "skills"), opts.keychain), builtInDir: opts.builtInSkillsDir })]);
  return { extraTools: combineExtraTools(mcpExtraTools(manager), skillExtraTools(catalog)), status, close: () => manager.close() };
}
