/**
 * The audit log outside the browser (the perch command, `perch serve`, MCP and the dev CLI): one
 * file in the Perch folder, with the company's copy when AuditLogPath is set.
 */

import { perchPaths } from "../daemon/paths";
import type { PolicyView } from "../policy/policy";
import { startPolicyWatcher } from "../policy/watch";
import { AuditLog } from "./audit";
import { PolicyAuditMirror } from "./audit-mirror";

export function homeAuditLog(opts: { env?: Record<string, string | undefined>; path?: string; policy?: PolicyView } = {}): AuditLog {
  const paths = perchPaths(opts.env ?? process.env);
  const path = opts.path ?? paths.auditFile;
  const policy = opts.policy ?? startPolicyWatcher();
  return new AuditLog(path, { legacy: path === paths.auditFile ? paths.legacyAuditFiles : [], mirror: new PolicyAuditMirror(policy) });
}
