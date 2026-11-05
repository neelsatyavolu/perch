/** How to run this same `perch` again: the compiled binary, or Bun with this source file. */

import { basename, join } from "node:path";

const MAIN = join(import.meta.dir, "main.ts");

export function selfCommand(execPath = process.execPath, main = MAIN): string[] {
  return /^bun(-debug)?$/.test(basename(execPath)) ? [execPath, "run", main] : [execPath];
}
