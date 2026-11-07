/** Where perchd keeps its socket, registry and logs (spec 7.1: the user's Application Support folder). */

import { homedir } from "node:os";
import { join } from "node:path";

export type PerchPaths = {
  home: string;
  runDir: string;
  socket: string;
  sessionsFile: string;
  clientsFile: string;
  /** The one audit log outside the browser: the perch command, `perch serve`, MCP and the dev CLI all write it. */
  auditFile: string;
  /** Audit logs older versions kept per client, merged into `auditFile` on first use. */
  legacyAuditFiles: string[];
  profileDir: string;
  logFile: string;
};

/** macOS limits a Unix socket path to 104 bytes, including the final NUL. */
const SOCKET_PATH_LIMIT = 103;

export function perchPaths(env: Record<string, string | undefined> = process.env): PerchPaths {
  const home = env.PERCH_HOME || join(env.HOME || homedir(), "Library", "Application Support", "Perch");
  const runDir = join(home, "run");
  const socket = join(runDir, "perchd.sock");
  if (Buffer.byteLength(socket) > SOCKET_PATH_LIMIT) throw new Error(`The Perch folder path is too long for a socket: ${socket}`);
  return {
    home,
    runDir,
    socket,
    sessionsFile: join(runDir, "sessions.json"),
    clientsFile: join(home, "clients.json"),
    auditFile: join(home, "audit.jsonl"),
    legacyAuditFiles: ["agent-audit.jsonl", "mcp-audit.jsonl", "dev-audit.jsonl", "exec-audit.jsonl"].map((f) => join(home, f)),
    profileDir: join(home, "agent-profile"),
    logFile: join(home, "perchd.log"),
  };
}
