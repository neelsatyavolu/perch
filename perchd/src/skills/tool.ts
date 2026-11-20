/**
 * Skills for the agent, read on demand (spec 7.5): the prompt lists each skill's name and
 * description, and load_skill returns a skill's instructions (or one of its files) when needed.
 */

import type { ToolResult } from "../agent/tools";
import { checkArgs, type ExtraTools } from "../mcp-client/extra-tools";
import type { ToolCall, ToolSpec } from "../models/types";
import type { SkillCatalog } from "./catalog";

export const LOAD_SKILL = "load_skill";
const PROMPT_SKILLS = 150;
const DESCRIPTION_IN_PROMPT = 300;
const FILE_LIMIT = 50_000;
/** How much of the skills a chat already read goes back in with each later message. */
const LOADED_LIMIT = 40_000;

const SPEC: ToolSpec = {
  name: LOAD_SKILL,
  description: "Read a skill's instructions before a task it covers. Pass file to read one of the skill's other files.",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Skill name from the list in the instructions" }, file: { type: "string", description: "A file inside the skill, such as reference.md" } },
    required: ["name"],
    additionalProperties: false,
  },
};

function frontmatterless(text: string): string {
  return text.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

/** The skills already read in full, by name. */
function loadedText(catalog: SkillCatalog, loaded: ReadonlySet<string>): string {
  let left = LOADED_LIMIT;
  const parts: string[] = [];
  for (const name of loaded) {
    const body = catalog.get(name) ? frontmatterless(catalog.read(name) ?? "") : "";
    if (!body || body.length > left) continue;
    left -= body.length;
    parts.push(`<skill name="${name}">\n${body}\n</skill>`);
  }
  return parts.length ? `You read these skills earlier in this chat. Here they are in full, so follow them and do not load them again:\n\n${parts.join("\n\n")}` : "";
}

/**
 * `loaded` is the chat's record of the skills it read with load_skill. Each message is a new run
 * that sees only the chat's text, so without it the agent loaded the same skill again every
 * message; with it, those skills come in the instructions instead.
 */
export function skillExtraTools(catalog: SkillCatalog, loaded?: Set<string>): ExtraTools {
  return {
    specs: () => (catalog.list().length ? [SPEC] : []),
    prompt(): string {
      const skills = catalog.list();
      if (skills.length === 0) return "";
      const lines = skills.slice(0, PROMPT_SKILLS).map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, " ").slice(0, DESCRIPTION_IN_PROMPT)}`);
      const list = [`Skills hold tested ways to work on particular sites and tasks. Before a task one covers, call ${LOAD_SKILL} with its name and follow it:`, ...lines].join("\n");
      const read = loaded ? loadedText(catalog, loaded) : "";
      return read ? `${list}\n\n${read}` : list;
    },
    handles: (name) => name === LOAD_SKILL && catalog.list().length > 0,
    check(call: ToolCall): string | null {
      const problem = checkArgs(SPEC.parameters as Record<string, unknown>, call.args, LOAD_SKILL);
      if (problem) return problem;
      if (typeof call.args.name !== "string" || (call.args.file !== undefined && typeof call.args.file !== "string")) return "name and file must be text";
      if (!catalog.get(call.args.name)) return `no skill named "${call.args.name.slice(0, 64)}"; use a name from the list`;
      return null;
    },
    describe(call: ToolCall) {
      const name = String(call.args.name);
      const file = typeof call.args.file === "string" ? call.args.file : undefined;
      return { kind: "read", site: "skills", summary: `Read the ${name} skill`, detail: file ? `${name}/${file}` : name, label: `Read the ${name} skill${file ? ` (${file})` : ""}` };
    },
    async run(call: ToolCall): Promise<ToolResult> {
      const name = String(call.args.name);
      const skill = catalog.get(name)!;
      const file = typeof call.args.file === "string" ? call.args.file : undefined;
      if (file) {
        const text = catalog.read(name, file);
        if (text === null) return { content: `the ${name} skill has no text file "${file.slice(0, 120)}"`, isError: true };
        return { content: text.length > FILE_LIMIT ? `${text.slice(0, FILE_LIMIT)}… (cut)` : text };
      }
      const body = frontmatterless(catalog.read(name) ?? "");
      loaded?.add(name);
      const others = Object.keys(skill.files).filter((p) => p !== "SKILL.md");
      const files = others.length ? `\n\nOther files in this skill (read one with ${LOAD_SKILL} and file): ${others.slice(0, 50).join(", ")}` : "";
      return { content: `${body}${files}` };
    },
  };
}
