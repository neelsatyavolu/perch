/**
 * `perchd-dev models …`: Settings → Models from the terminal, until the settings page exists (plan 3b).
 * Uses the real Keychain and the encrypted settings in ~/Library/Application Support/Perch.
 *
 *   models providers | list <provider> | test <provider> | roles
 *   models sign-in codex|grok | key <provider> | endpoint <provider> [base-url] [--no-key] | claude-code | sign-out <provider>
 *   models role <role> <provider>:<model> [effort] | models role <role> clear
 *   models image "<prompt>" <folder>
 */

import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { systemKeychain } from "./config/keychain";
import { SettingsStore } from "./config/store";
import { isProviderId, isRole, isRoleEffort, type ProviderId, type Role, type RoleChoice } from "./models/ids";
import { createModelRegistry, type ModelRegistry } from "./models/registry";

export type ModelSpec = { role: Exclude<Role, "image"> } | { provider: ProviderId; model?: string };

export function parseModelSpec(spec: string): ModelSpec {
  if (spec.startsWith("role:")) {
    const role = spec.slice(5);
    if (role === "image") throw new Error("The Image role makes pictures; use `models image` to generate one.");
    if (!isRole(role)) throw new Error(`Unknown role "${role}".`);
    return { role: role as Exclude<Role, "image"> };
  }
  const [provider, ...rest] = spec.split(":");
  if (!isProviderId(provider)) throw new Error(`Unknown provider "${provider}".`);
  return rest.length ? { provider, model: rest.join(":") } : { provider };
}

export function parseRoleArg(args: string[]): { role: Role; choice: RoleChoice | null } {
  const [role, target, effort] = args;
  if (!isRole(role)) throw new Error("Name a role: default, fast, standard, deep, visual or image.");
  if (target === "clear") return { role, choice: null };
  const spec = target ? parseModelSpec(target) : null;
  if (!spec || !("provider" in spec) || !spec.model) throw new Error("Give the model as provider:model, for example openai:gpt-6-astra.");
  if (effort !== undefined && !isRoleEffort(effort)) throw new Error("The effort is one of off, low, medium, high or max.");
  return { role, choice: { provider: spec.provider, model: spec.model, ...(effort ? { effort } : {}) } };
}

/** `endpoint <provider> [base-url] [--no-key]`: the address to use, and whether to remove the saved key. */
export function parseEndpointArgs(args: string[]): { baseUrl?: string; clearKey: boolean } {
  const rest = args.slice(1);
  const baseUrl = rest.find((a) => a !== "--no-key");
  return { ...(baseUrl ? { baseUrl } : {}), clearKey: rest.includes("--no-key") };
}

export async function openRegistry(): Promise<ModelRegistry> {
  const dir = process.env.PERCH_HOME ?? join(homedir(), "Library", "Application Support", "Perch");
  const keychain = systemKeychain();
  return createModelRegistry({ store: await SettingsStore.open({ dir, keychain }), keychain });
}

/** Reads a line without echoing it, so a pasted key never shows on screen. */
async function readSecret(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  const tty = process.stdin.isTTY;
  if (tty) spawnSync("stty", ["-echo"], { stdio: "inherit" });
  const rl = createInterface({ input: process.stdin });
  try {
    for await (const line of rl) return line;
    return "";
  } finally {
    rl.close();
    if (tty) spawnSync("stty", ["echo"], { stdio: "inherit" });
    process.stderr.write("\n");
  }
}

async function signIn(registry: ModelRegistry, id: ProviderId): Promise<string> {
  const { url, needsPaste } = await registry.startSignIn(id);
  process.stderr.write(`Open this address in a browser and sign in:\n${url}\n`);
  if (needsPaste) {
    const pasted = await readSecret("Paste the address or code the page shows: ");
    await registry.finishSignIn(id, pasted);
    return "Signed in.";
  }
  process.stderr.write("Waiting for the browser to come back (10 minutes)…\n");
  for (let i = 0; i < 600; i++) {
    if ((await registry.listProviders()).find((p) => p.id === id)?.connected) return "Signed in.";
    await Bun.sleep(1000);
  }
  return "The sign-in timed out. Run the command again.";
}

const out = (value: unknown) => process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);

export async function modelsCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const registry = await openRegistry();
  const provider = () => {
    if (!isProviderId(rest[0])) throw new Error("Name a provider, for example openai.");
    return rest[0];
  };
  try {
    switch (command) {
      case "providers":
        for (const p of await registry.listProviders()) out(`${p.id.padEnd(12)} ${p.state.padEnd(14)} ${p.label}${p.baseUrl ? `  ${p.baseUrl}` : ""}`);
        break;
      case "list":
        for (const m of await registry.listModels(provider())) out(`${m.id}  ${m.label}${m.vision ? "  vision" : ""}${m.imageOutput ? "  images" : ""}${m.context ? `  ${m.context} tokens` : ""}`);
        break;
      case "test":
        out(await registry.testConnection(provider()));
        break;
      case "roles":
        for (const [role, r] of Object.entries(await registry.getRoles())) out(`${role.padEnd(9)} ${r ? `${r.provider}:${r.model}${r.effort ? ` (${r.effort})` : ""}  ${r.source}${r.note ? `  ${r.note}` : ""}` : "none"}`);
        break;
      case "sign-in":
        out(await signIn(registry, provider()));
        break;
      case "key":
        out((await registry.setKey(provider(), await readSecret(`${provider()} API key: `))).message);
        break;
      case "endpoint": {
        const id = provider();
        const { baseUrl, clearKey } = parseEndpointArgs(rest);
        // An empty answer keeps the saved key (or none); --no-key removes it.
        const typed = clearKey ? null : (await readSecret(`${id} API key (press Return to keep the saved one, or for none): `)).trim();
        const key = clearKey ? null : typed ? typed : undefined;
        out((await registry.connectEndpoint(id, { ...(baseUrl ? { baseUrl } : {}), ...(key !== undefined ? { key } : {}) })).message);
        break;
      }
      case "claude-code":
        out((await registry.connectClaudeCode()).message);
        break;
      case "sign-out":
        await registry.signOut(provider());
        out("Signed out.");
        break;
      case "role": {
        const { role, choice } = parseRoleArg(rest);
        const r = (await registry.setRole(role, choice))[role];
        out(r ? `${role}: ${r.provider}:${r.model}` : `${role}: none`);
        break;
      }
      case "image":
        for (const f of await registry.generateImage({ prompt: rest[0] ?? "", folder: resolve(rest[1] ?? ".") })) out(f.path);
        break;
      default:
        process.stderr.write("usage: models providers|list|test|roles|sign-in|key|endpoint|claude-code|sign-out|role|image\n");
        return 64;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    registry.dispose();
  }
}
