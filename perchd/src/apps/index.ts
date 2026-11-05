/**
 * Tools for the owner's other apps, offered to Perch's own agent when the app is installed.
 * Each has its own permission kinds and runs outside the browser.
 */

import type { Kind } from "../agent/permissions";
import type { ToolSpec } from "../models/types";
import { checkFlint, FLINT_SPEC, flintAlwaysAsks, flintBinary, flintKind, runFlint, type AppToolResult } from "./flint";

export type AppTool = {
  spec: ToolSpec;
  /** What the audit log and approval cards name as the site. */
  site: string;
  kind(args: Record<string, unknown>): Kind;
  /** Calls that ask the user whatever the mode or an "allow" site rule says. */
  alwaysAsks(args: Record<string, unknown>): boolean;
  check(args: Record<string, unknown>): string | null;
  run(args: Record<string, unknown>): Promise<AppToolResult>;
  available(env: Record<string, string | undefined>): boolean;
};

export const APP_TOOLS: readonly AppTool[] = [
  { spec: FLINT_SPEC, site: "Flint", kind: flintKind, alwaysAsks: flintAlwaysAsks, check: checkFlint, run: (args) => runFlint(args), available: (env) => flintBinary(env) !== null },
];

export function appTool(name: string): AppTool | undefined {
  return APP_TOOLS.find((t) => t.spec.name === name);
}

/** The browser tools plus the app tools that are installed on this Mac. */
export function agentToolSpecs(base: ToolSpec[], env: Record<string, string | undefined> = process.env): ToolSpec[] {
  return [...base, ...APP_TOOLS.filter((t) => t.available(env)).map((t) => t.spec)];
}
