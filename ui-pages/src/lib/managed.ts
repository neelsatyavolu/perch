/**
 * Which Settings rows a company policy locks (spec 12.2). A locked row shows its value, is
 * disabled and says "Managed by your organization". perchd refuses the same writes, so this only
 * decides what the page shows. With no policy nothing is locked.
 */

import type { PolicyState } from "../api";

export const MANAGED_NOTE = "Managed by your organization";

/** Settings anchors (sections.ts SEARCH_INDEX) a policy can lock. */
export type RowId =
  | "permission-mode" | "client-rules" | "providers"
  | "memory-extraction" | "history-extraction" | "dreaming"
  | "import-browsers" | "built-in-backrow" | "memory-saver" | "auto-update" | "sync";

type Values = PolicyState["values"];

const RULES: readonly [RowId, (v: Values) => boolean][] = [
  ["permission-mode", (v) => v.MaxPermissionMode !== undefined || v.AgentEnabled === false],
  ["client-rules", (v) => v.MaxPermissionMode !== undefined || v.MCPServerEnabled === false || v.AllowedMCPClients !== undefined],
  ["providers", (v) => v.AllowedModelProviders !== undefined || v.AllowedModels !== undefined || v.ModelEndpoints !== undefined],
  ["memory-extraction", (v) => v.MemoryEnabled === false],
  ["history-extraction", (v) => v.MemoryEnabled === false || v.HistoryExtractionEnabled === false],
  ["dreaming", (v) => v.MemoryEnabled === false],
  ["import-browsers", (v) => v.ImportEnabled !== undefined],
  ["built-in-backrow", (v) => (v.BuiltInExtensions as { backrow?: unknown } | undefined)?.backrow !== undefined],
  ["memory-saver", (v) => (v.BuiltInExtensions as { memorySaver?: unknown } | undefined)?.memorySaver !== undefined],
  ["sync", (v) => v.SyncEnabled === false || v.SyncDisabled === true],
  ["auto-update", (v) => v.AutoUpdateEnabled !== undefined || v.UpdateChannel !== undefined || v.UpdateDelayDays !== undefined || v.MinimumVersion !== undefined],
];

export function managedRows(values: Values | undefined): ReadonlySet<RowId> {
  if (!values) return new Set();
  return new Set(RULES.filter(([, locks]) => locks(values)).map(([row]) => row));
}
