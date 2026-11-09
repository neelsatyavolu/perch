/**
 * Aside's skill files as skill bundles: one bundle per folder that has a SKILL.md, read the way
 * Perch reads any skill folder (src/skills/bundle.ts).
 */

import type { TextFile } from "../../import/types";
import { bundleFromText, type SkillBundle } from "../../skills/bundle";

export type AsideSkills = { readonly bundles: readonly SkillBundle[]; readonly unreadable: number };

/** Files grouped by their first folder; a file outside any folder belongs to no skill. */
function byFolder(files: readonly TextFile[]): Map<string, TextFile[]> {
  const folders = new Map<string, TextFile[]>();
  for (const file of files) {
    const cut = file.path.indexOf("/");
    if (cut <= 0) continue;
    const folder = file.path.slice(0, cut);
    const list = folders.get(folder) ?? [];
    list.push({ path: file.path.slice(cut + 1), text: file.text });
    folders.set(folder, list);
  }
  return folders;
}

export function skillsFromAside(files: readonly TextFile[]): AsideSkills {
  const read = [...byFolder(files)].map(([folder, texts]): SkillBundle | null => {
    try {
      return bundleFromText(folder, texts);
    } catch {
      // No SKILL.md, no description, or too large: counted as left out.
      return null;
    }
  });
  const bundles = read.filter((b): b is SkillBundle => b !== null);
  return { bundles, unreadable: read.length - bundles.length };
}
