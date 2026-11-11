/**
 * Every skill the agent can use: Perch's built-in site skills (plain SKILL.md folders shipped with
 * perchd) and the user's own (encrypted, from SkillStore). A user's skill with the same name as a
 * built-in one replaces it. Skills switched off in Settings are left out.
 */

import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { bundleText, readSkillFolder, type SkillBundle } from "./bundle";
import type { SkillStore } from "./store";

export type SkillEntry = SkillBundle & { origin: "built-in" | "mine" };

/**
 * perchd/skills in development. The compiled perchd (Helpers/perchd in the app) has no source
 * tree, so the app ships the folder as Resources/perch_skills next to it.
 */
export function builtInSkillsDir(dir = import.meta.dir, execPath = process.execPath): string {
  return dir.includes("$bunfs") ? join(dirname(execPath), "..", "Resources", "perch_skills") : join(dir, "..", "..", "skills");
}

export const BUILT_IN_SKILLS_DIR = builtInSkillsDir();

export async function loadBuiltInSkills(dir: string = BUILT_IN_SKILLS_DIR): Promise<SkillBundle[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const bundles = await Promise.all(entries.filter((e) => e.isDirectory()).map((e) => readSkillFolder(join(dir, e.name)).catch(() => null)));
  return bundles.filter((b): b is SkillBundle => b !== null);
}

export class SkillCatalog {
  private constructor(private readonly skills: ReadonlyMap<string, SkillEntry>) {}

  static async load(opts: { builtInDir?: string; store?: SkillStore } = {}): Promise<SkillCatalog> {
    const builtIn = await loadBuiltInSkills(opts.builtInDir);
    const mine = opts.store ? await opts.store.list() : [];
    const off = opts.store ? await opts.store.disabled() : new Set<string>();
    const map = new Map<string, SkillEntry>();
    for (const b of builtIn) map.set(b.name, { ...b, origin: "built-in" });
    for (const m of mine) map.set(m.name, { name: m.name, description: m.description, files: m.files, origin: "mine" });
    return new SkillCatalog(new Map([...map].filter(([name]) => !off.has(name))));
  }

  static of(entries: SkillEntry[]): SkillCatalog {
    return new SkillCatalog(new Map(entries.map((e) => [e.name, e])));
  }

  list(): SkillEntry[] {
    return [...this.skills.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SkillEntry | undefined {
    return this.skills.get(name);
  }

  /** SKILL.md's body, or one of the skill's other text files. */
  read(name: string, file = "SKILL.md"): string | null {
    const skill = this.skills.get(name);
    return skill ? bundleText(skill, file) : null;
  }
}
