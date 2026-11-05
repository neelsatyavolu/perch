/**
 * The user's own skills ("My skills", spec 7.5), each stored as one encrypted file (spec 11.1).
 * `exportSkill` writes a plain SKILL.md folder back out, for Claude Code or Codex.
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { SecretStore } from "../secure/keychain";
import { dataKey, readSealedJson, writeSealedJson } from "../secure/sealed";
import type { SkillBundle } from "./bundle";
import { SKILL_NAME } from "./skill-file";

const LABEL = "perch/skill/v1";
const EXT = ".skill";

export type StoredSkill = SkillBundle & { source: string; installedAt: string };

function checkName(name: string): void {
  if (!SKILL_NAME.test(name)) throw new Error(`"${name.slice(0, 40)}" is not a valid skill name`);
}

export class SkillStore {
  constructor(
    readonly dir: string,
    private readonly keychain: SecretStore,
  ) {}

  private path(name: string): string {
    checkName(name);
    return join(this.dir, `${name}${EXT}`);
  }

  async names(): Promise<string[]> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    return entries.filter((f) => f.endsWith(EXT)).map((f) => f.slice(0, -EXT.length)).filter((n) => SKILL_NAME.test(n)).sort();
  }

  async get(name: string): Promise<StoredSkill | null> {
    return readSealedJson<StoredSkill>(this.path(name), await dataKey(this.keychain), LABEL);
  }

  async list(): Promise<StoredSkill[]> {
    const all = await Promise.all((await this.names()).map((n) => this.get(n).catch(() => null)));
    return all.filter((s): s is StoredSkill => s !== null);
  }

  async install(bundle: SkillBundle, source: string): Promise<StoredSkill> {
    const skill: StoredSkill = { ...bundle, source, installedAt: new Date().toISOString() };
    await writeSealedJson(this.path(bundle.name), await dataKey(this.keychain), LABEL, skill);
    return skill;
  }

  async remove(name: string): Promise<void> {
    await rm(this.path(name), { force: true });
  }

  /** Writes the skill as a plain folder: <dir>/<name>/SKILL.md and its files. */
  async exportSkill(name: string, dir: string): Promise<string> {
    const skill = await this.get(name);
    if (!skill) throw new Error(`no skill named "${name}"`);
    const root = join(dir, skill.name);
    for (const [path, data] of Object.entries(skill.files)) {
      const target = normalize(join(root, path));
      if (!target.startsWith(`${root}/`)) throw new Error(`the skill file "${path}" points outside its folder`);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(data, "base64"));
    }
    return root;
  }
}
