# Perch roadmap

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md` (approved 2026-11-03)

The spec covers nine subsystems (spec section 15). Each gets its own implementation plan, and each plan ends with something the owner can use. A plan is written when the work it depends on has landed, because later Chromium patches name files and line ranges in the pinned tree, which only exists after plan 1.

## Plans

| # | Plan | Delivers | Needs | Status |
|---|---|---|---|---|
| 1 | Fork pipeline | `perch-build` tool, patch series, Perch branding and icon, Widevine on, signed and notarized DMG, Sparkle updates, first release | nothing | written: `2026-11-03-perch-01-fork-pipeline.md` |
| 2 | Shell | Themes and token file, restyled tab strip, toolbar and profile menu, hide-chrome mode, split view, Brave search with Tab for Google, privacy patches and the allowed-connections settings, true incognito, built-in memory saver and Backrow, DRM playback check, and the Chrome-missing features in spec 5.9 (content blocker, command bar, reader view, auto picture in picture, link preview and the rest) | 1 | next on the Chromium track |
| 3a | Agent core (`perchd`) | Bun binary, CDP over `--remote-debugging-pipe`, page snapshot with refs, actions, REPL, agent tabs, model adapters (shared-ai-auth Codex and Grok, Claude Code headless, Claude API key), permission modes, audit log | nothing (develops against Chrome for Testing) | written: `2026-11-05-perch-03a-agent-core.md` |
| 3b | Agent in the browser | Custom CDP domains (credential fill, approvals, tab ownership), sidebar chat WebUI with side chats bound to their tab, full-page chat, artifacts pane and `perch-artifact://` origin, Settings → Models (providers, task model roles) | 2, 3a | |
| 4 | Outside agents and MCP | `perch` CLI, MCP server, Unix socket with per-client tokens, `perch skill install`, agterm MCP injection, built-in site skills, MCP client with import from Claude Code, Codex, Claude Desktop, Cursor and Grok, ChatGPT/Grok sign-in | 3a | the MCP server part is started early for benchmarks |
| 5 | Memory | Encrypted markdown store, extraction, dreaming, FTS5 plus local embeddings, Memory page | 3a (store and search), 3b (page) | |
| 6 | Import | Readers for every browser in spec section 10, open-tab restore asleep, Aside extras, wizard | 2 (restore), 5 (Aside memory) | |
| 7 | Account, sync and relay | Cloudflare Worker, D1 and R2 sync server speaking Chromium's sync protocol, encrypted blob sync, relay with Durable Objects, pairing, remote MCP, Grok Bot prompt | 3a for the relay client; server side needs nothing | server can start now |
| 8 | Enterprise | `.pkg`, Chrome policy check, Perch policies, `perch://policy`, audit log export, company sync with OpenID Connect, SBOM | 2, 4, 7 | |
| 9 | Benchmarks, speed, 1.0 (no public release before every feature works; owner 2026-11-05) | `bench/` runner for the three suites, section 13 measurements, published results, 1.0 release, `perchbrowser.com` | everything | |

## Tracks that run at the same time

Chromium builds take hours, so three tracks run side by side:

- **Chromium track**: 1 → 2 → 3b → 8. Mostly waiting on builds.
- **perchd track**: 3a → 4 → 5, plus the file parsers in 6. Pure TypeScript with fast tests, developed against Chrome for Testing until the Perch build exists.
- **Server track**: 7's Worker, tested with Miniflare.

Recommended next plan after this one: 3a, written and started while plan 1's first builds run.

## Owner actions

These need the owner, not an agent:

1. Buy `perchbrowser.com`.
2. Approve creating the public GitHub repo `neelsatyavolu/perch` (plan 1, task 8 needs it to publish a release).
3. Create the Sparkle EdDSA key and save it in 1Password (plan 1, task 7 gives the commands).
4. Apply to Google's Widevine programme for a VMP certificate (spec 5.2).
5. Rotate the Aside provider tokens exposed earlier in the design session: sign out of and back in to Claude, Codex and Grok in Aside.
6. Launch the first signed build and the update test by hand (plan 1, task 9). Agents never drive the GUI while the owner is using the Mac.
