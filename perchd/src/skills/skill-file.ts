/**
 * The SKILL.md format Claude Code and Codex use: YAML frontmatter with name and description, then
 * a markdown body. Only the top-level scalar fields are read; lists and maps (allowed-tools,
 * metadata) are skipped, so any valid skill loads.
 */

export type SkillHead = { name: string; description: string };
export type ParsedSkill = SkillHead & { body: string };

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DESCRIPTION_LIMIT = 1024;

/** A skill name from anything: lowercase letters, digits and hyphens, at most 64 characters. */
export function skillName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
  return t;
}

/** Top-level `key: value` pairs, with `>` and `|` blocks and plain continuation lines. */
function frontmatter(yaml: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = yaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i]!.match(/^([A-Za-z_][\w-]*):(?:\s+(.*))?$/);
    if (!m) continue;
    const key = m[1]!;
    const rest = (m[2] ?? "").trim();
    const block: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || lines[i + 1] === "")) block.push(lines[++i]!);
    if (/^[>|][+-]?$/.test(rest)) {
      const text = block.map((l) => l.trim());
      out[key] = rest.startsWith(">") ? text.filter(Boolean).join(" ") : text.join("\n").trim();
    } else if (rest && !block.some((l) => /^\s+-\s/.test(l))) {
      out[key] = unquote([rest, ...block.map((l) => l.trim())].filter(Boolean).join(" "));
    }
  }
  return out;
}

/** Parses a SKILL.md. The folder name is used when the name is missing or not in the allowed form. */
export function parseSkillFile(text: string, folderName: string): ParsedSkill {
  const m = text.match(/^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error("SKILL.md must start with frontmatter (--- name and description ---)");
  const head = frontmatter(m[1]!);
  const description = (head.description ?? "").trim();
  if (!description) throw new Error("SKILL.md needs a description");
  const named = skillName(head.name ?? "");
  const name = named && SKILL_NAME.test(named) ? named : skillName(folderName);
  if (!SKILL_NAME.test(name)) throw new Error("the skill has no usable name");
  return { name, description: description.slice(0, DESCRIPTION_LIMIT), body: m[2]!.trim() };
}
