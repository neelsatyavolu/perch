/**
 * An MCP server's command line or URL as the pages see it: every secret replaced by `${NAME}` and
 * only the names listed (ui-pages/src/api.ts, `McpServer.target`). Values in the Keychain show by
 * name; anything that still looks like a token is caught by the pages' own redaction rule.
 */

import { redactTarget } from "../../../../ui-pages/src/lib/redact";
import { secretArgIndexes } from "../../mcp-client/secrets";
import type { ServerConfig, Value } from "../../mcp-client/types";

export type Shown = { readonly target: string; readonly secretNames: readonly string[] };

const PURE_VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;

const nameOf = (raw: string) => raw.replace(/^-+/, "").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "").toUpperCase() || "TOKEN";

/** The name an argument's secret goes by: its flag's name, or its position. */
export function argSecretName(args: readonly Value[], index: number): string {
  const prev = args[index - 1];
  return typeof prev === "string" && /^-{1,2}[A-Za-z]/.test(prev) && !prev.includes("=") ? nameOf(prev) : `ARG_${index + 1}`;
}

/** Whether a typed argument holds a secret, by Perch's launch rules or the pages' redaction rule. */
export function isSecretArg(args: readonly string[], index: number): boolean {
  const word = args[index]!;
  if (secretArgIndexes(args).includes(index)) return true;
  if (redactTarget(word).secrets.length > 0) return true;
  const prev = args[index - 1];
  return prev !== undefined && redactTarget(`${prev} ${word}`).secrets.length > redactTarget(prev).secrets.length;
}

const quoted = (word: string) => (/\s/.test(word) ? JSON.stringify(word) : word);
const isSecretValue = (v: Value) => (typeof v === "string" ? !PURE_VAR.test(v) : "secret" in v);

/** Works on saved entries (secrets are Keychain references) and on raw import candidates alike. */
export function showTarget(config: ServerConfig): Shown {
  const names: string[] = [];
  const take = (name: string) => (names.push(name), `\${${name}}`);
  let line: string;
  if (config.transport === "stdio") {
    const raw = config.args.map((a) => (typeof a === "string" ? a : ""));
    const words = config.args.map((a, i) => {
      if (typeof a !== "string") return "env" in a ? `\${${a.env}}` : take(argSecretName(config.args, i));
      return isSecretArg(raw, i) ? take(argSecretName(config.args, i)) : quoted(a);
    });
    line = [quoted(config.command), ...words].join(" ");
    names.push(...Object.entries(config.env).filter(([, val]) => isSecretValue(val)).map(([k]) => k));
  } else {
    line = config.url;
    names.push(...Object.entries(config.headers).filter(([, val]) => isSecretValue(val)).map(([k]) => k));
  }
  const caught = redactTarget(line);
  return { target: caught.target, secretNames: [...new Set([...names, ...caught.secrets.map((s) => s.name)])] };
}

/** Splits a typed command line into words, honouring single and double quotes. */
export function splitCommand(line: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = "";
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error("A quote in the command isn't closed");
  if (started) words.push(current);
  return words;
}
