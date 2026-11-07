/**
 * Settings → Skills and MCP, the server half: the encrypted server registry, the import scan of
 * other apps' configs, and the live manager. Secret values go to the Keychain on the way in
 * (src/mcp-client/secrets.ts); the pages only ever get names. A server the person adds or imports
 * here is approved to launch, since they just saw what it runs.
 */

import type { McpImportCandidate, McpImportSource, McpServer, McpTransport } from "../../../../ui-pages/src/api";
import type { Candidate } from "../../mcp-client/importers/normalize";
import { preview, saveImports } from "../../mcp-client/importers/preview";
import { launchFingerprint } from "../../mcp-client/launch";
import { deleteServer } from "../../mcp-client/manager";
import { addServer, findServer, freeName, updateServer } from "../../mcp-client/registry";
import { account, storeSecrets } from "../../mcp-client/secrets";
import { parseConfig, sanitizeName, type ServerConfig, type ServerEntry, type Value } from "../../mcp-client/types";
import { AppError } from "../runs";
import * as v from "../validate";
import { gone, plainly, type Methods } from "./common";
import type { PagesDeps } from "./deps";
import { isSecretArg, showTarget, splitCommand } from "./mcp-target";

const TRANSPORTS: readonly McpTransport[] = ["stdio", "http", "sse"];
const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/;
const SOURCES: readonly [string, McpImportSource][] = [
  ["Claude Code", "claude-code"], ["Codex", "codex"], ["Claude Desktop", "claude-desktop"], ["Cursor", "cursor"], ["Grok", "grok"],
];

const sourceOf = (label: string | undefined): McpImportSource | null => SOURCES.find(([prefix]) => label?.startsWith(prefix))?.[1] ?? null;
const candidateKey = (c: Candidate) => `${c.source}\n${c.name}`;

function checkUrl(raw: string): string {
  const url = URL.canParse(raw.trim()) ? new URL(raw.trim()) : null;
  const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!url || !/^https?:$/.test(url.protocol)) throw new AppError("Enter the server's web address, starting with https://");
  if (url.protocol === "http:" && !local) throw new AppError("Use https for a server that isn't on this Mac");
  return raw.trim();
}

function secretsInput(value: unknown): { name: string; value: string }[] {
  return v.list(value, "secrets", 50).map((item, i) => {
    const o = v.object(item, `"secrets[${i}]"`);
    v.onlyKeys(o, ["name", "value"]);
    const name = v.text(o.name, "name", 128).trim();
    if (!SECRET_NAME.test(name)) throw new AppError("Use letters, numbers, - and _ in secret names, like GITHUB_TOKEN");
    const val = v.text(o.value, "value", 10_000);
    if (!val) throw new AppError(`Enter a value for ${name}`);
    return { name, value: val };
  });
}

export function mcpPages(deps: PagesDeps): Methods<"listMcpServers" | "scanMcpImports" | "importMcpServers" | "addMcpServer" | "updateMcpServer" | "removeMcpServer"> {
  const { store, keychain, manager } = deps.mcp;

  function view(entry: ServerEntry): McpServer {
    const tools = manager.tools().filter((t) => t.server.name === entry.name);
    const shown = showTarget(entry.config);
    return {
      id: entry.name, name: entry.name, transport: entry.config.transport, target: shown.target, source: sourceOf(entry.source) ?? "manual",
      tools: tools.length, readOnlyTools: tools.filter((t) => t.tool.annotations.readOnlyHint === true).length,
      trusted: entry.trusted, enabled: entry.enabled, secretNames: shown.secretNames,
    };
  }

  async function entry(id: unknown): Promise<ServerEntry> {
    return findServer(await store.load(), v.id(id, "id")) ?? gone("That server was removed");
  }

  /** Connects in the background; the Settings page reads the tool count on its next load. */
  const connect = (name: string) => void manager.connect(name).catch(() => undefined);

  /** Import candidates the page may offer: from a known app, valid, and not an unapproved project file. */
  async function offered() {
    const found = await deps.mcp.findImports();
    const items = preview(await store.load(), found.candidates);
    const list = found.candidates.flatMap((c, i) => {
      const item = items[i]!;
      const source = sourceOf(c.source);
      const invalid = item.warnings.some((w) => w.includes("cannot be imported"));
      if (!source || invalid || item.duplicateOf || (c.projectFile && c.approved !== true)) return [];
      return [{ index: i, candidate: c, item, source }];
    });
    return { candidates: found.candidates, list };
  }

  async function approve(names: readonly string[]): Promise<ServerEntry[]> {
    const reg = await store.update((r) => names.reduce((acc, n) => {
      const e = findServer(acc, n);
      return e ? updateServer(acc, n, { approvedLaunch: launchFingerprint(e.config) }) : acc;
    }, r));
    return names.flatMap((n) => findServer(reg, n) ?? []);
  }

  async function configFor(name: string, transport: McpTransport, target: string, secrets: { name: string; value: string }[]): Promise<ServerConfig> {
    const named = Object.fromEntries(secrets.map((s) => [s.name, s.value]));
    if (transport !== "stdio") return parseConfig({ transport, url: checkUrl(target), headers: named });
    const line = v.text(target, "target", 2000).trim();
    if (!line) throw new AppError("Enter the command that starts the server");
    if (/[\r\n]/.test(line)) throw new AppError("The command must be on one line");
    const [command, ...words] = await plainly(() => splitCommand(line));
    const config = parseConfig({ transport, command, args: words, env: named });
    if (config.transport !== "stdio") throw new AppError("Enter the command that starts the server");
    // Tokens typed into the command line go to the Keychain one whole argument at a time.
    const args: Value[] = await Promise.all(
      words.map(async (word, i) => {
        if (!isSecretArg(words, i)) return word;
        await keychain.set(account(name, "arg", i), word);
        return { secret: account(name, "arg", i) };
      }),
    );
    return { ...config, args };
  }

  return {
    async listMcpServers() {
      return (await store.load()).servers.map(view);
    },
    async scanMcpImports() {
      return (await offered()).list.map(({ candidate, item, source }): McpImportCandidate => {
        const shown = showTarget(candidate.config);
        return {
          key: candidateKey(candidate), name: item.name, source, configPath: candidate.path, transport: candidate.config.transport,
          target: shown.target, secretNames: shown.secretNames, alreadyAdded: item.alreadyAdded,
        };
      });
    },
    async importMcpServers([rawKeys]) {
      const keys = new Set(v.list(rawKeys, "keys", 500).map((k, i) => v.text(k, `keys[${i}]`, 400)));
      const { candidates, list } = await offered();
      const ids = list.filter((o) => keys.has(candidateKey(o.candidate)) && !o.item.alreadyAdded).map((o) => o.index);
      if (!ids.length) return [];
      const result = await saveImports(store, keychain, candidates, ids);
      if (!result.saved.length && result.failed[0]) throw new AppError(`Couldn't import ${result.failed[0].name}: ${result.failed[0].error}`);
      const saved = await approve(result.saved);
      for (const s of saved) connect(s.name);
      return saved.map(view);
    },
    async addMcpServer([input]) {
      const o = v.object(input, '"input"');
      v.onlyKeys(o, ["name", "transport", "target", "secrets"]);
      const title = v.text(o.name, "name", 60).trim();
      if (!title) throw new AppError("Give it a name");
      const transport = v.oneOf(o.transport, "transport", TRANSPORTS);
      const secrets = secretsInput(o.secrets);
      const name = freeName(await store.load(), sanitizeName(title));
      const typed = await plainly(() => configFor(name, transport, v.text(o.target, "target", 2000), secrets));
      const config = await storeSecrets(name, typed, keychain);
      const reg = await plainly(() =>
        store.update((r) => addServer(r, { name, config, enabled: true, trusted: false, approvedLaunch: launchFingerprint(config), addedAt: new Date().toISOString() })),
      );
      const added = findServer(reg, name)!;
      connect(added.name);
      return view(added);
    },
    async updateMcpServer([id, rawPatch]) {
      const current = await entry(id);
      const o = v.object(rawPatch, '"patch"');
      v.onlyKeys(o, ["enabled", "trusted"]);
      const patch = {
        ...(o.enabled === undefined ? {} : { enabled: v.bool(o.enabled, "enabled") }),
        ...(o.trusted === undefined ? {} : { trusted: v.bool(o.trusted, "trusted") }),
      };
      const next = findServer(await store.update((r) => updateServer(r, current.name, patch)), current.name)!;
      if (patch.enabled === true && !current.enabled) connect(next.name);
      if (patch.enabled === false) await manager.disconnect(next.name);
      return view(next);
    },
    async removeMcpServer([id]) {
      const current = await entry(id);
      await manager.disconnect(current.name);
      await deleteServer(store, keychain, current.name);
    },
  };
}
