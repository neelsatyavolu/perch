/** How to run this same `perch` again: the compiled binary, or Bun with this source file. */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");

/**
 * Inside Perch.app the binary sits in the framework's Versions/<version>/Helpers, a folder an
 * update replaces; the framework's own Helpers link always points at the current version, so
 * anything saved to run perch later (an agent's MCP config, the perch command) uses that.
 */
export function stableBinary(execPath: string, exists: (path: string) => boolean = existsSync): string {
  const stable = execPath.replace(/\/Versions\/[^/]+\/Helpers\//, "/Helpers/");
  return stable !== execPath && exists(stable) ? stable : execPath;
}

export function selfCommand(execPath = process.execPath, main = MAIN): string[] {
  return /^bun(-debug)?$/.test(basename(execPath)) ? [execPath, "run", main] : [stableBinary(execPath)];
}
