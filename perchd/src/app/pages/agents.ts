/**
 * The tour's "Connect your agents" step: the perch command on PATH and Perch's skill and MCP
 * server in Claude Code, Codex and Grok (src/cli/install/connect.ts), and which of them has used
 * Perch since (the daemon's client registry).
 */

import type { AgentSetup, OutsideAgent } from "../../../../ui-pages/src/api";
import { agentStates, commandState, connectAgents, type AgentState, type CommandState } from "../../cli/install/connect";
import type { InstallEnv } from "../../cli/install/index";
import { selfCommand } from "../../cli/self";
import type { Methods } from "./common";
import type { PagesDeps } from "./deps";

const AGENTS: readonly OutsideAgent[] = ["claude", "codex", "grok"];
const NAMES: Readonly<Record<OutsideAgent, string>> = { claude: "Claude Code", codex: "Codex", grok: "Grok" };
/** The client name each agent's MCP connection registers as (cli/mcp-proxy.ts). */
const CLIENTS: Readonly<Record<OutsideAgent, string>> = { claude: "claude-code", codex: "codex", grok: "grok" };

export function agentsPages(deps: PagesDeps, ienv: () => InstallEnv = () => ({ home: deps.skills.home, env: process.env, command: selfCommand() })): Methods<"getAgentSetup" | "connectAgents"> {
  const setup = (states: readonly AgentState[], command: CommandState): AgentSetup => {
    const used = new Set(deps.clients.list().filter((c) => !c.revoked && c.lastUsed).map((c) => c.name));
    return {
      agents: states.map((s) => ({ id: s.id, name: NAMES[s.id], found: s.found, installed: s.installed, connected: used.has(CLIENTS[s.id]), ...(s.error ? { error: s.error } : {}) })),
      command,
    };
  };
  return {
    async getAgentSetup() {
      const env = ienv();
      return setup(agentStates(AGENTS, env), commandState(env));
    },
    async connectAgents() {
      const result = connectAgents(AGENTS, ienv());
      return setup(result.agents, result.command);
    },
  };
}
