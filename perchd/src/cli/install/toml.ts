/**
 * Perch's MCP server in a Codex or Grok `config.toml`, as a marked block at the end of the file.
 * The block is the only text Perch adds or removes, so uninstalling gives back the file as it was.
 */

import { readText, writeSafely, type Change } from "./files";
import { parse as parseToml } from "smol-toml";

const BEGIN = "# perch:begin";
const END = "# perch:end";
const BLOCK = /\n?# perch:begin[^\n]*\n[\s\S]*?# perch:end\n?/;
const HAND_MADE = /^\s*\[\s*mcp_servers\s*\.\s*("perch"|perch)\s*\]/m;

function tomlString(s: string): string {
  return JSON.stringify(s);
}

export function tomlBlock(agent: "codex" | "grok", command: string[]): string {
  const args = [...command.slice(1), "mcp", "--client", agent];
  return [
    `${BEGIN} (added by \`perch skill install ${agent}\`; \`perch skill uninstall ${agent}\` removes it)`,
    "[mcp_servers.perch]",
    `command = ${tomlString(command[0]!)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    // Browser actions wait for pages; Codex's 60 s default is too short for some.
    ...(agent === "codex" ? ["tool_timeout_sec = 120"] : []),
    END,
    "",
  ].join("\n");
}

export function checkToml(file: string, text: string): void {
  try {
    // smol-toml follows the TOML spec; Bun's own parser rejects files Codex and Grok read fine.
    parseToml(text);
  } catch {
    throw new Error(`${file} is not valid TOML; Perch left it unchanged`);
  }
}

export function installTomlServer(file: string, agent: "codex" | "grok", command: string[], now: Date): Change {
  const before = readText(file);
  const text = before ?? "";
  if (before !== null) checkToml(file, before);
  const block = tomlBlock(agent, command);
  const withoutOurs = text.replace(BLOCK, "");
  if (!BLOCK.test(text) && HAND_MADE.test(text)) return { file, action: "skipped", note: "it already has a perch server you set up; left as is" };
  if (withoutOurs !== text && HAND_MADE.test(withoutOurs)) return { file, action: "skipped", note: "it has a second perch server; left as is" };
  const base = BLOCK.test(text) ? withoutOurs : text;
  const next = base === "" ? block : `${base}${base.endsWith("\n") ? "" : "\n"}\n${block}`;
  if (next === text) return { file, action: "unchanged" };
  checkToml(file, next);
  return writeSafely(file, before, next, { now, newMode: 0o600 });
}

export function uninstallTomlServer(file: string, now: Date): Change {
  const before = readText(file);
  if (before === null || !BLOCK.test(before)) {
    return before !== null && HAND_MADE.test(before) ? { file, action: "skipped", note: "its perch server was not added by Perch; left as is" } : { file, action: "unchanged" };
  }
  // The block and the blank line before it are exactly what the install added.
  const next = before.replace(BLOCK, "");
  const change = writeSafely(file, before, next, { now, newMode: 0o600 });
  return { ...change, action: "removed" };
}
