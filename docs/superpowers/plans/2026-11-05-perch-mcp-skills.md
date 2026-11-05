# Perch plan 4 (track): MCP client and skills

**Goal:** the Perch agent can call tools from the user's MCP servers and use `SKILL.md` skills. Users import the servers they already set up in Claude Code, Codex, Claude Desktop, Cursor, Grok and VS Code with one step, see what will be imported (name, command or URL, which secrets) before anything is saved, and their secrets end up in the macOS Keychain, never in a plain file.

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md` 7.4, 7.5, 11.1. Roadmap row 4.

**Branch:** `perch/mcp-skills`. All work is in `perchd/`, tested with `bun test` against fixture servers written in the tests and fixture configs in a temporary HOME. No test touches the real Keychain, the user's config files or the network.

## Aside parity checklist (this area)

| Aside | Perch | Status in this plan |
|---|---|---|
| Add MCP servers (stdio, HTTP) in Settings → Skills / MCPs | stdio, Streamable HTTP, legacy SSE fallback | client and registry here; the settings page is plan 3b (UI) |
| OAuth sign-in for remote MCP servers | OAuth 2.1 with discovery (RFC 9728, RFC 8414), dynamic client registration (RFC 7591), PKCE, loopback redirect; tokens in the Keychain, refreshed when they expire | here |
| — (Aside has no import) | one-step import from Claude Code (`~/.claude.json` user and project scopes, `.mcp.json`), Codex (`~/.codex/config.toml`), Claude Desktop, Cursor, Grok (`~/.grok/config.toml`), VS Code (`mcp.json`) with a preview | here |
| MCP tools usable by the agent | exposed to `runTask` as `mcp__<server>__<tool>`; read-only tools run freely, others are risky (trusted server: change); never auto-approved in Ask mode; audited | here |
| Built-in site skills read on demand | `perchd/skills/<name>/SKILL.md`; names and descriptions in the prompt, bodies loaded with `load_skill` | loader here; a first set of site skills here, the full list in the built-in skills task |
| My skills: import from a folder | import from a folder, `~/.claude/skills`, `~/.codex/skills`, `~/.grok/skills`; stored encrypted | here; URL and git import deferred |
| Per-chat server switch | `disabled` set per task | here (data); the toggle UI is plan 3b |

## Security rules this plan holds to

- Every value from a server's `env`, `headers` (and Codex `http_headers`, `bearer_token_env_var`), and secret-looking command arguments (`--token x`, `--api-key=x`) is written to the Keychain on save. The registry stores only a reference (`{ secret: id }`).
- The registry and user skills are encrypted with AES-256-GCM (`node:crypto`). The data key is a random 32-byte key kept in the Keychain. **Deferred:** wrapping that key with a Secure Enclave key (spec 11.1) needs a signed native helper; it lands with the browser build (plan 3b).
- Keychain writes go through `security -i` on stdin, so a secret never appears in a process's argument list.
- The import preview never contains a secret value: only names and where each value goes.
- An imported stdio server asks for approval before its first launch, and again whenever its command or arguments change.
- MCP tool output is cut to 20,000 characters, as REPL output is.

## File layout

```
perchd/src/secure/keychain.ts     SecretStore interface; macOS Keychain (security -i); in-memory store for tests
perchd/src/secure/sealed.ts       AES-256-GCM sealed JSON files keyed by a Keychain data key
perchd/src/mcp-client/types.ts    server entry types and validation at the boundary
perchd/src/mcp-client/registry.ts encrypted server registry, immutable updates
perchd/src/mcp-client/secrets.ts  move secrets to the Keychain on save, resolve them at launch
perchd/src/mcp-client/jsonrpc.ts  JSON-RPC over a transport: ids, timeouts, cancellation, server requests
perchd/src/mcp-client/stdio.ts    stdio transport
perchd/src/mcp-client/sse.ts      SSE parser and the legacy HTTP+SSE transport
perchd/src/mcp-client/http.ts     Streamable HTTP transport, falls back to SSE
perchd/src/mcp-client/oauth.ts    OAuth discovery, registration, PKCE, loopback, refresh
perchd/src/mcp-client/client.ts   initialize, tools/list with paging, tools/call, list_changed
perchd/src/mcp-client/manager.ts  connects enabled servers, launch approval, status per server
perchd/src/mcp-client/agent-tools.ts  MCP tools as agent tools: specs, classification, approval, audit
perchd/src/mcp-client/importers/*.ts  one reader per app, plus preview and save
perchd/src/mcp-client/cli.ts      dev CLI: import preview and save, list, remove, tools
perchd/src/skills/*.ts            SKILL.md parsing, loader, encrypted store, import, load_skill tool
perchd/skills/<name>/SKILL.md     built-in site skills
```

Shared files touched: `perchd/src/agent/loop.ts` (accept extra tools and a prompt addition), `perchd/package.json` and `bun.lock` (`smol-toml`, because Bun's own TOML parser rejects valid keys such as `[mcp_servers.1password]`).

## Tasks

1. Secure storage: Keychain store (command builder tested; the real Keychain is not touched by tests), sealed files.
2. Server types, validation and the encrypted registry.
3. JSON-RPC core and the stdio transport, tested against a fixture stdio server.
4. Streamable HTTP and SSE fallback, tested against `Bun.serve` fixtures.
5. OAuth for remote servers, tested against a fixture authorization server.
6. Client and manager: tools paging, list_changed, launch approval, per-server status.
7. Agent tools: names, specs, classification by `readOnlyHint` and trust, approvals in Ask/Guard/Skip, audit lines, result conversion; `runTask` integration.
8. Importers for each app, preview, save with secrets moved to the Keychain.
9. Skills: parser, built-in and user folders, encrypted store, import from Claude Code, Codex and Grok, `load_skill` in `runTask`.
10. Dev CLI, docs, full test run and typecheck.

## Deferred, and why

- **Secure Enclave wrap of the data key**: needs a signed native helper (plan 3b).
- **Settings → Skills and MCP page, per-chat switches, approval cards**: UI is plan 3b; this plan provides the data and calls.
- **Skill import from a URL or git repo**: folder import covers the importers named here; network fetch of skills needs its own review of what runs.
- **MCP resources, prompts, sampling and elicitation**: Perch's agent only needs tools now; the client answers `ping` and declines other server requests.
- **Skill scripts**: bodies and file lists are shown to the agent; running a skill's scripts needs the file-access approvals in 7.4 and comes with the shell tool.

## How to try it (until the settings page exists)

From `perchd/`:

```
bun run src/mcp-client/cli.ts import                 # preview: what Perch found, which secrets go to the Keychain
bun run src/mcp-client/cli.ts import --save all      # or --save github,linear
bun run src/mcp-client/cli.ts list
bun run src/mcp-client/cli.ts tools github           # asks before running a stdio server for the first time
bun run src/mcp-client/cli.ts trust github | disable github | remove github
bun run src/mcp-client/cli.ts skills import --save all
bun run src/mcp-client/cli.ts skills                 # built-in and imported skills
```

Settings go to `~/Library/Application Support/Perch` (`--dir` to use another folder); secrets go to the login Keychain under the service "Perch". In code, pass `extraTools: combineExtraTools(mcpExtraTools(manager), skillExtraTools(catalog))` to `runTask`.

Packaging note: the built-in skills are read from `perchd/skills/` next to the source (`BUILT_IN_SKILLS_DIR`). The compiled perchd binary needs that folder shipped in the app bundle and the path passed to `SkillCatalog.load({ builtInDir })`.
