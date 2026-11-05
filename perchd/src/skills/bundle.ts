/**
 * A skill folder read into memory: SKILL.md plus its other files (references, scripts, assets).
 * Symlinks, dotfiles and dependency folders are skipped, and size is capped, so importing a skill
 * cannot pull in the rest of the disk.
 */

import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { parseSkillFile, type SkillHead } from "./skill-file";

export type SkillBundle = SkillHead & {
  /** Relative path to base64 contents. Always includes SKILL.md. */
  files: Readonly<Record<string, string>>;
};

const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const SKIP = new Set(["node_modules", "__pycache__", ".git", ".venv", "venv"]);

async function walk(root: string, dir: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    const info = await lstat(path);
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) await walk(root, path, out);
    else if (info.isFile()) out.push(relative(root, path).split(sep).join("/"));
    if (out.length > MAX_FILES) throw new Error(`the skill has more than ${MAX_FILES} files`);
  }
}

export async function readSkillFolder(dir: string): Promise<SkillBundle> {
  const text = await readFile(join(dir, "SKILL.md"), "utf8").catch(() => null);
  if (text === null) throw new Error("the folder has no SKILL.md");
  const head = parseSkillFile(text, basename(dir));
  const paths: string[] = [];
  await walk(dir, dir, paths);
  let total = 0;
  const files: Record<string, string> = {};
  for (const path of paths.sort()) {
    const data = await readFile(join(dir, path));
    total += data.length;
    if (total > MAX_BYTES) throw new Error("the skill is larger than 5 MB");
    files[path] = data.toString("base64");
  }
  return { name: head.name, description: head.description, files };
}

/** Text of one file in a bundle, or null when it is missing or binary. */
export function bundleText(bundle: SkillBundle, path: string): string | null {
  const data = bundle.files[path];
  if (data === undefined) return null;
  const buf = Buffer.from(data, "base64");
  if (buf.includes(0)) return null;
  return buf.toString("utf8");
}

/** Files a skill can run, shown in the import preview. */
export function scriptFiles(bundle: SkillBundle): string[] {
  return Object.keys(bundle.files).filter((p) => /\.(sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|applescript|scpt)$/i.test(p) || p.startsWith("scripts/"));
}
