/**
 * The import preview (spec 7.5: Perch lists what it found and the user picks) and the save step.
 * A preview never holds a secret value: it names each secret and says it goes to the Keychain.
 */

import type { SecretStore } from "../../secure/keychain";
import { addServer, freeName, type Registry, type RegistryStore } from "../registry";
import { secretArgIndexes, storeSecrets, varsIn } from "../secrets";
import { parseConfig, sanitizeName, type ServerConfig, type Value } from "../types";
import type { Candidate } from "./normalize";

export type PreviewItem = {
  /** Index into the candidates list; pass it back to saveImports. */
  id: number;
  /** The name it will have in Perch (made unique). */
  name: string;
  originalName: string;
  source: string;
  path: string;
  transport: ServerConfig["transport"];
  /** The command line or URL, with secret values shown as ••••. */
  target: string;
  /** Values that move to the Keychain, such as "env GITHUB_TOKEN" or "header Authorization". */
  secrets: string[];
  /** Variables read from Perch's environment at launch. */
  fromEnv: string[];
  warnings: string[];
  /** Picked by default: not a duplicate, not already in Perch, on in its own app, and approved there if it comes from a project file. */
  selected: boolean;
  /** From a config file inside a project folder (a repository may have put it there). */
  projectFile: boolean;
  duplicateOf?: string;
  alreadyAdded: boolean;
};

const SECRET_QUERY = /(key|token|secret|password|auth|sig|signature|code)/i;
const PURE_VAR = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/;
const MASK = "••••";

/** A value goes to the Keychain unless it only names a variable. */
function isSecret(v: Value): boolean {
  if (typeof v !== "string") return !("env" in v);
  return !(PURE_VAR.test(v) && v.startsWith("$"));
}

/** Every variable a value reads from Perch's environment at launch. */
const readsFrom = (v: Value): string[] => (typeof v === "string" ? varsIn(v) : "env" in v ? [v.env] : []);

export function maskUrl(raw: string): { url: string; warnings: string[] } {
  try {
    const url = new URL(raw);
    const hidden = [...url.searchParams.keys()].filter((k) => SECRET_QUERY.test(k));
    for (const k of hidden) url.searchParams.set(k, MASK);
    const warnings = hidden.length ? [`The URL carries a credential (${hidden.join(", ")}). It is kept in Perch's encrypted settings.`] : [];
    if (url.username || url.password) {
      url.username = url.password ? url.username : MASK;
      url.password = url.password ? MASK : "";
    }
    return { url: url.toString().replaceAll(encodeURIComponent(MASK), MASK), warnings };
  } catch {
    return { url: raw.slice(0, 200), warnings: ["The URL is not valid; this server cannot be imported."] };
  }
}

function sameTarget(a: ServerConfig, b: ServerConfig): boolean {
  if (a.transport === "stdio" && b.transport === "stdio") return a.command === b.command && JSON.stringify(a.args) === JSON.stringify(b.args);
  return a.transport !== "stdio" && b.transport !== "stdio" && a.url === b.url;
}

function describe(c: Candidate): Pick<PreviewItem, "target" | "secrets" | "fromEnv" | "warnings"> {
  const vars = (values: Value[]) => [...new Set(values.flatMap(readsFrom))];
  const secretsOf = (kind: string, map: Record<string, Value>) => Object.entries(map).filter(([, v]) => isSecret(v)).map(([k]) => `${kind} ${k}`);
  if (c.config.transport === "stdio") {
    const { command, args, env, cwd } = c.config;
    const hidden = new Set(secretArgIndexes(args));
    const secrets = [...[...hidden].map((i) => `argument ${i + 1}`), ...secretsOf("env", env)];
    const shown = args.map((a, i) => (hidden.has(i) ? MASK : typeof a === "string" ? (/\s/.test(a) ? JSON.stringify(a) : a) : MASK));
    return { target: [command, ...shown].join(" "), secrets, fromEnv: vars([command, ...args, ...Object.values(env), ...(cwd ? [cwd] : [])]), warnings: [...c.warnings] };
  }
  const masked = maskUrl(c.config.url);
  return { target: masked.url, secrets: secretsOf("header", c.config.headers), fromEnv: vars([c.config.url, ...Object.values(c.config.headers)]), warnings: [...c.warnings, ...masked.warnings] };
}

export function preview(reg: Registry, candidates: readonly Candidate[]): PreviewItem[] {
  const seen: { name: string; config: ServerConfig }[] = [];
  const taken = new Set<string>();
  return candidates.map((c, id) => {
    const base = sanitizeName(c.name);
    const existing = reg.servers.find((s) => s.name === base);
    const alreadyAdded = Boolean(existing && existing.source === c.source) || Boolean(existing && sameTarget(existing.config, c.config));
    const dup = seen.find((s) => s.name === base && sameTarget(s.config, c.config));
    seen.push({ name: base, config: c.config });
    const name = alreadyAdded || dup ? base : freeName(reg, base, taken);
    if (!alreadyAdded && !dup) taken.add(name);
    const d = describe(c);
    const invalid = d.warnings.some((w) => w.includes("cannot be imported"));
    return {
      id,
      name,
      originalName: c.name,
      source: c.source,
      path: c.path,
      transport: c.config.transport,
      ...d,
      selected: !alreadyAdded && !dup && c.enabled && !invalid && (!c.projectFile || c.approved === true),
      projectFile: c.projectFile === true,
      ...(dup ? { duplicateOf: dup.name } : {}),
      alreadyAdded,
    };
  });
}

export type SaveResult = { saved: string[]; failed: { name: string; error: string }[] };

/** Saves the picked servers: secrets to the Keychain, the rest to the encrypted registry. */
export async function saveImports(store: RegistryStore, keychain: SecretStore, candidates: readonly Candidate[], ids: readonly number[]): Promise<SaveResult> {
  const saved: string[] = [];
  const failed: { name: string; error: string }[] = [];
  await store.update(async (current) => {
    let reg = current;
    const items = preview(reg, candidates);
    for (const id of new Set(ids)) {
      const c = candidates[id];
      const item = items[id];
      if (!c || !item) continue;
      if (item.alreadyAdded || item.duplicateOf) continue;
      try {
        const name = freeName(reg, item.name);
        parseConfig(c.config); // refuse a bad entry before any secret is written
        const config = await storeSecrets(name, c.config, keychain);
        reg = addServer(reg, { name, config, enabled: true, trusted: false, source: c.source, addedAt: new Date().toISOString() });
        saved.push(name);
      } catch (error) {
        failed.push({ name: item.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return reg;
  });
  return { saved, failed };
}
