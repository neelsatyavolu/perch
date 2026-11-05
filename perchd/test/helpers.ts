import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A throwaway Chrome profile folder, removed by the returned cleanup. */
export function tempProfile(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "perchd-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
