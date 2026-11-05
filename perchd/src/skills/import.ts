/**
 * Finding skills to import from Claude Code (~/.claude/skills), Codex (~/.codex/skills) and Grok
 * (~/.grok/skills), or from any folder, with a preview before anything is copied into Perch.
 */

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readSkillFolder, scriptFiles, type SkillBundle } from "./bundle";
import type { SkillStore } from "./store";

export type SkillCandidate = { source: string; dir: string; bundle: SkillBundle };
export type SkillPreview = { id: number; name: string; description: string; source: string; dir: string; files: number; scripts: string[]; installed: boolean; selected: boolean };

type Problem = { path: string; message: string };

/** Folders directly inside dir, following a link at this level (shared and plugin skills are often linked in). */
async function folders(dir: string): Promise<{ names: string[]; problems: Problem[] }> {
  const entries = (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => !e.name.startsWith("."));
  const checked = await Promise.all(
    entries.map(async (e): Promise<string | Problem | null> => {
      if (e.isDirectory()) return e.name;
      if (!e.isSymbolicLink()) return null;
      const target = await stat(join(dir, e.name)).catch(() => null);
      if (!target) return { path: join(dir, e.name), message: "the link leads to nothing; it was skipped" };
      return target.isDirectory() ? e.name : null;
    }),
  );
  return {
    names: checked.filter((c): c is string => typeof c === "string").sort((a, b) => a.localeCompare(b)),
    problems: checked.filter((c): c is Problem => Boolean(c) && typeof c === "object"),
  };
}

/** Every skill folder (one with SKILL.md) directly inside dir. */
export async function skillsIn(dir: string, source: string): Promise<{ candidates: SkillCandidate[]; problems: Problem[] }> {
  const listed = await folders(dir);
  const results = await Promise.all(
    listed.names.map(async (name): Promise<{ candidate: SkillCandidate } | { problem: Problem }> => {
      const path = join(dir, name);
      try {
        return { candidate: { source, dir: path, bundle: await readSkillFolder(path) } };
      } catch (error) {
        return { problem: { path, message: error instanceof Error ? error.message : String(error) } };
      }
    }),
  );
  return {
    candidates: results.flatMap((r) => ("candidate" in r ? [r.candidate] : [])),
    problems: [...listed.problems, ...results.flatMap((r) => ("problem" in r && !/no SKILL\.md/.test(r.problem.message) ? [r.problem] : []))],
  };
}

export async function findSkillImports(opts: { home: string; env?: Record<string, string | undefined> }) {
  const env = opts.env ?? {};
  const sources: [string, string][] = [
    [join(opts.home, ".claude", "skills"), "Claude Code"],
    [join(env.CODEX_HOME || join(opts.home, ".codex"), "skills"), "Codex"],
    [join(env.GROK_HOME || join(opts.home, ".grok"), "skills"), "Grok"],
  ];
  const found = await Promise.all(sources.map(([dir, source]) => skillsIn(dir, source)));
  return { candidates: found.flatMap((f) => f.candidates), problems: found.flatMap((f) => f.problems) };
}

export function previewSkills(installed: ReadonlySet<string>, candidates: readonly SkillCandidate[]): SkillPreview[] {
  const seen = new Set<string>();
  return candidates.map((c, id) => {
    const first = !seen.has(c.bundle.name);
    seen.add(c.bundle.name);
    const isInstalled = installed.has(c.bundle.name);
    return {
      id,
      name: c.bundle.name,
      description: c.bundle.description,
      source: c.source,
      dir: c.dir,
      files: Object.keys(c.bundle.files).length,
      scripts: scriptFiles(c.bundle),
      installed: isInstalled,
      selected: first && !isInstalled,
    };
  });
}

export async function importSkills(store: SkillStore, candidates: readonly SkillCandidate[], ids: readonly number[]): Promise<string[]> {
  const done: string[] = [];
  for (const id of new Set(ids)) {
    const c = candidates[id];
    if (!c || done.includes(c.bundle.name)) continue;
    await store.install(c.bundle, c.source);
    done.push(c.bundle.name);
  }
  return done;
}
