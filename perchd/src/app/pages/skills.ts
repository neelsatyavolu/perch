/**
 * Settings → Skills and MCP, the skills half: Perch's built-in skills and the person's own
 * (src/skills/store.ts), each of which can be switched off. A skill is added from a folder with a
 * SKILL.md; links and git repositories are not fetched yet.
 */

import { isAbsolute, join } from "node:path";
import type { Skill, SkillOrigin } from "../../../../ui-pages/src/api";
import { readSkillFolder } from "../../skills/bundle";
import { loadBuiltInSkills } from "../../skills/catalog";
import type { StoredSkill } from "../../skills/store";
import { AppError } from "../runs";
import * as v from "../validate";
import { gone, notYet, plainly, type Methods } from "./common";
import type { PagesDeps } from "./deps";

const ADD_ORIGINS = ["folder", "url", "git"] as const;

function originOf(skill: StoredSkill): { origin: SkillOrigin; location?: string } {
  if (/aside/i.test(skill.source)) return { origin: "aside", location: skill.source };
  return { origin: "folder", location: skill.source };
}

export function skillsPages(deps: PagesDeps): Methods<"listSkills" | "addSkill" | "setSkillEnabled" | "removeSkill"> {
  const { store } = deps.skills;

  async function all(): Promise<Skill[]> {
    const [builtIn, mine, off] = await Promise.all([loadBuiltInSkills(deps.skills.builtInDir), store.list(), store.disabled()]);
    const own = new Set(mine.map((m) => m.name));
    return [
      ...builtIn.filter((b) => !own.has(b.name)).map((b): Skill => ({ id: b.name, name: b.name, description: b.description, origin: "built-in", enabled: !off.has(b.name) })),
      ...mine.map((m): Skill => ({ id: m.name, name: m.name, description: m.description, ...originOf(m), enabled: !off.has(m.name) })),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  async function skill(id: unknown): Promise<Skill> {
    const clean = v.id(id, "id");
    return (await all()).find((s) => s.id === clean) ?? gone("That skill was removed");
  }

  return {
    listSkills: () => all(),
    async addSkill([input]) {
      const o = v.object(input, '"input"');
      v.onlyKeys(o, ["origin", "location"]);
      const origin = v.oneOf(o.origin, "origin", ADD_ORIGINS);
      const location = v.text(o.location, "location", 2000).trim();
      if (origin !== "folder") return notYet("Perch can't add a skill from a link or a git repository yet. Download it and add its folder.");
      const path = location.startsWith("~/") ? join(deps.skills.home, location.slice(2)) : location;
      if (!isAbsolute(path) || /\s$/.test(path)) throw new AppError("Enter a folder path, like ~/skills/pdf");
      const bundle = await plainly(() => readSkillFolder(path).catch((e: Error) => Promise.reject(new Error(`Couldn't add that folder: ${e.message}`))));
      if (await store.get(bundle.name).catch(() => null)) throw new AppError(`A skill named ${bundle.name} is already in Perch`, 409);
      await store.install(bundle, location);
      return skill(bundle.name);
    },
    async setSkillEnabled([id, enabled]) {
      const found = await skill(id);
      await store.setEnabled(found.id, v.bool(enabled, "enabled"));
      return skill(found.id);
    },
    async removeSkill([id]) {
      const found = await skill(id);
      if (found.origin === "built-in") throw new AppError("Built-in skills can be turned off, not removed");
      await store.remove(found.id);
    },
  };
}
