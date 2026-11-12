import { expect, test } from "bun:test";
import { managedRows, type RowId } from "../../src/lib/managed";
import { SEARCH_INDEX } from "../../src/pages/settings/sections";

const rows = (values: Record<string, unknown>) => [...managedRows(values)].sort();

test("an unmanaged policy locks nothing", () => {
  expect(rows({})).toEqual([]);
  expect([...managedRows(undefined)]).toEqual([]);
});

test.each<[string, Record<string, unknown>, RowId[]]>([
  ["MaxPermissionMode", { MaxPermissionMode: "guard" }, ["client-rules", "permission-mode"]],
  ["AgentEnabled", { AgentEnabled: false }, ["permission-mode"]],
  ["MemoryEnabled", { MemoryEnabled: false }, ["dreaming", "memory-extraction"]],
  ["MCPServerEnabled", { MCPServerEnabled: false }, ["client-rules"]],
  ["AllowedMCPClients", { AllowedMCPClients: ["codex"] }, ["client-rules"]],
  ["AllowedModelProviders", { AllowedModelProviders: ["anthropic"] }, ["providers"]],
  ["AllowedModels", { AllowedModels: ["anthropic/claude-sonnet-5-5"] }, ["providers"]],
  ["ModelEndpoints", { ModelEndpoints: [] }, ["providers"]],
  ["ImportEnabled", { ImportEnabled: { data: ["bookmarks"] } }, ["import-browsers"]],
  ["BuiltInExtensions", { BuiltInExtensions: { backrow: false } }, ["built-in-backrow"]],
  ["BuiltInExtensions memory saver", { BuiltInExtensions: { memorySaver: false } }, ["memory-saver"]],
  ["AutoUpdateEnabled", { AutoUpdateEnabled: false }, ["auto-update"]],
  ["UpdateDelayDays", { UpdateDelayDays: 7 }, ["auto-update"]],
])("%s locks its rows", (_name, values, expected) => {
  expect(rows(values)).toEqual([...expected].sort());
});

test("policies with no Settings row lock nothing", () => {
  expect(rows({ AgentEnabled: true, MemoryEnabled: true, TelemetryEnabled: false, AuditLogPath: "~/a.jsonl", SyncServerURL: "https://s.example.com" })).toEqual([]);
});

test("every row a policy can lock is a real Settings anchor", () => {
  const anchors = new Set(SEARCH_INDEX.map((e) => e.anchor));
  const all = managedRows({
    MaxPermissionMode: "ask", MemoryEnabled: false, AllowedModels: [], ImportEnabled: {}, BuiltInExtensions: { backrow: false, memorySaver: false }, AutoUpdateEnabled: false,
  });
  for (const row of all) expect(anchors.has(row)).toBe(true);
});
