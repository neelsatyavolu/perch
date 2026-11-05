# Perch plan 4a: the `perch` CLI, outside agents and the owner's apps

**Goal:** Outside agents (Claude Code, Codex, Grok, and the agents agterm and agmux start) use Perch through one local endpoint, each in its own named tab group, under Perch's rules. agterm, agmux and Flint each get a small, clean Perch integration.

**Spec:** sections 7.1 (socket), 7.4 (per-client rules), 9.1 (CLI), 9.2 (MCP), 9.4 (agterm and the owner's apps), 11.1 (secrets in the Keychain). Owner, 2026-11-05: "make it so agmux and agterm, my coding apps, have special features to use the browser cleanly; integrate other possible apps cleanly, maybe flint as well".

## Aside parity for this area

| Aside | Perch | Here |
|---|---|---|
| `aside [prompt]`, `aside exec` | `perch exec` (Claude Code or Codex headless, as today) | kept, routed through the new CLI |
| `aside repl` | `perch repl "<js>"` | yes |
| `aside mcp` (exec, repl, browser_profiles) | `perch mcp`: every browser tool, in the client's own session | yes |
| `aside guide` (skill is a stub that defers to the CLI) | `perch guide`; the installed skill points to it | yes |
| `aside session list/stop` | `perch sessions`, `perch session end` | yes |
| Agent tabs share one "Agent" group | one group per outside session: "Claude Code · perch" | yes (label tracked by perchd; drawing the group is a 3b patch) |
| No per-client identity | a token per client in the Keychain, per-client mode, revocable | yes |
| Approvals only in the Aside window | MCP elicitation in the client (Claude Code shows the card), a y/N prompt for the CLI on a terminal | yes |
| `aside login`, `aside host` (remote) | plan 7 | deferred |
| `aside memory` | plan 5 | deferred |

## Design

- **perchd daemon** (`perchd/src/daemon/`). One process owns the browser. It listens on `~/Library/Application Support/Perch/run/perchd.sock` (folder 0700, socket 0600; `PERCH_HOME` moves the folder for tests). The spec puts the socket in Application Support, so that wins over "runtime dir"; macOS has no XDG runtime dir.
- **Clients and tokens.** A client is a named identity (`cli`, `claude-code`, `codex`, `grok`, `agterm`, `agmux`). Its token is 32 random bytes in the Keychain (service "Perch clients"), written through `security -i` on stdin so it never appears in a process list, and compared in constant time. `clients.json` (0600) holds only names, mode (Guard by default), first and last use, and revoked. **[builder call]** First use registers a client (trust on first use) because the socket is already limited to the user; a revoked client stays revoked until `perch clients allow`. The mode comes from the registry, never from what the client asks for.
- **Sessions.** A connection names a session (`--session`, default: one per process) and a title (default: the working folder's name). Each session gets its own tool context, so its own tabs; its tab group is "<agent> · <title>". A tab belongs to one session: `switch_tab` to another session's tab is refused, and switching to one of the user's tabs claims it until the session ends. MCP sessions end when the client disconnects (after a 10 s grace for restarts); their tabs close, or sleep (frozen) with `--on-end sleep`. CLI sessions end with `perch session end`, and sleep after 30 idle minutes.
- **Indicators.** perchd writes `run/sessions.json` (0600): client, session, agent, title, label, tab count. No URLs or titles of pages. agterm and agmux read it to show a browser mark on a tab, and run `perch focus` to bring that session's tabs forward.
- **Approvals.** The daemon asks the connection. `perch mcp` turns that into MCP elicitation when the client supports it, else declines with a plain reason. One-shot CLI commands ask on the terminal, or decline when there is none.
- **Skill install.** `perch skill install claude|codex|grok` writes `skills/perch/SKILL.md` and adds a `perch` MCP server to `~/.claude.json` (JSON merge), `~/.codex/config.toml` or `~/.grok/config.toml` (a marked TOML block). Each changed file gets a timestamped backup first, the write is atomic and keeps the file's mode, unchanged runs write nothing, and `perch skill uninstall` removes only what Perch added. Honours `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `GROK_HOME`.
- **Flint.** A `flint` tool for Perch's own agent, offered only when the flint CLI is installed: reads run freely, actions follow the permission mode, and `send` always asks in Perch and then waits for Flint's own approval. Built-in skill text in `perchd/skills/flint/SKILL.md`.

## File layout

```
perchd/src/daemon/   paths.ts keychain.ts clients.ts protocol.ts sessions.ts server.ts daemon.ts
perchd/src/cli/      main.ts client.ts commands.ts mcp-proxy.ts self.ts install/{files,claude,toml,index}.ts
perchd/src/apps/     flint.ts
perchd/skills/       perch/SKILL.md, flint/SKILL.md
perchd/test/         keychain clients sessions daemon cli mcp-proxy install flint .test.ts
integrations/        agterm/, agmux/, flint/: patches for the owner's apps (see below)
```

Shared files, touched minimally: `perchd/package.json` (bin build script), `perchd/src/agent/tool-specs.ts`, `tools.ts` and `permissions.ts` (one hook each for app tools).

## Tasks

1. Paths, Keychain (`security -i`, injected runner; a memory keychain for tests), client registry. Tests: tokens never in argv, constant-time verify, revoke sticks, file modes.
2. Socket server and protocol: hello within 5 s, line limit, unknown methods, approval round trip. Tests with a fake browser context where possible.
3. Session manager: own tabs, ownership refusal, borrowed tabs, end closes or sleeps, sessions.json. Browser test.
4. CLI: open, tabs, snapshot, screenshot, click, type, repl, status, sessions, session end, focus, clients, guide, serve, exec. In-process tests against a daemon on a temp `PERCH_HOME`.
5. `perch mcp` proxy with elicitation approvals. Test with an in-process daemon.
6. Skill install and uninstall for the three agents. Tests in a temp home only.
7. Flint tool and skill. Tests with a fake flint script.
8. agterm, agmux, Flint integrations, each checked with the app's own fast checks.

## The owner's apps

The task asked for a git worktree per app (`<repo>-perch`, branch `feat/perch-integration`). This agent runs isolated to the Perch worktree and its harness refuses git commands on other repositories, so each integration is built and checked in a scratch copy of the app and delivered as a patch in `integrations/<app>/`, with the commands to apply it on a worktree.

- **agterm:** adds a `perch` MCP server (`perch mcp --client agterm --session <tab id> --agent <agent> --title <folder>`) to the claude and codex it starts when the perch CLI is installed (Settings → Agents switch, on by default); a browser mark on a tab whose agent has Perch tabs, which brings them forward on click; web links open in Perch when it is installed.
- **agmux:** the same server for Claude Code and Codex PTY sessions, a mark on the thread row with click to focus, and web links (terminal and chat) open in Perch.
- **Flint:** "Open in Perch" on a link's context menu, shown when Perch is installed.

## Deferred, and why

- Drawing tab groups and the tab-ownership CDP domain in the browser: plan 3b's patches. perchd calls `Perch.setTabGroup` and falls back to tracking labels itself when the method is missing (Chrome for Testing).
- `perch exec` through the daemon's browser and Perch's own model sign-in: needs plan 4's ChatGPT/Grok sign-in. `perch exec` keeps running Claude Code or Codex headless.
- Approving client and mode changes in the browser UI (3b), memory commands (plan 5), remote hosts and login (plan 7), encrypting the audit log per record (with plan 5's store).
- A compiled `perch` binary in the app bundle and a `/usr/local/bin` link: plan 1's packaging. `bun run build:cli` writes `perchd/dist/perch` for now.
