# perchd

Perch's agent core. It drives Chromium over a private DevTools pipe, reads pages as compact snapshots, acts with real input events, asks before risky actions, and runs a task loop with Codex, Grok or Claude models.

## Develop

```sh
bun install
bunx @puppeteer/browsers install chrome@stable --path ~/.cache/perch-cft   # headless test browser
bun test
bunx tsc --noEmit
```

Tests run Chrome for Testing headless against local fixture pages in `test/fixtures/pages`. They never open a window or call a real model.

## Try a task

```sh
ANTHROPIC_API_KEY=… bun run src/cli.ts run --model anthropic:claude-sonnet-5-5 "Find the cheapest nonstop SFO to HND on Dec 18"
bun run src/cli.ts run --model fake "anything"     # wiring check, no model
```

Add `--show` to watch the browser and `--mode ask|guard|skip` to change the permission mode (Guard by default).

## Connect models

Until the Settings → Models page exists, the same API runs from the terminal. Keys and sign-in tokens go to the login Keychain; choices go to an encrypted file in `~/Library/Application Support/Perch` (`PERCH_HOME` changes the folder).

In this dev setup the Keychain items trust the `bun` binary that created them, so any other script run by bun on this Mac can read them without asking. Use keys you can revoke, with low spending limits, until perchd ships as a signed binary with its items bound to Perch's signature.

```sh
bun run src/cli.ts models sign-in codex          # ChatGPT; also: grok
bun run src/cli.ts models key openai             # asks for the key without echoing it; also anthropic, xai, gemini, openrouter
bun run src/cli.ts models endpoint ollama http://127.0.0.1:11434/v1   # asks for an optional key; Return keeps the saved one
bun run src/cli.ts models endpoint custom https://gateway.example.com/v1 --no-key   # --no-key removes a saved key
bun run src/cli.ts models claude-code            # uses the installed Claude Code CLI as the runner
bun run src/cli.ts models providers              # what is connected
bun run src/cli.ts models roles                  # Default, Fast, Standard, Deep, Visual, Image
bun run src/cli.ts models role deep openai:gpt-6-astra high
bun run src/cli.ts models image "A lighthouse at dawn" ~/Desktop
bun run src/cli.ts run --model role:deep "…"      # or --model codex, --model ollama:qwen3:8b
```

## Layout

| Path | What |
|---|---|
| `src/cdp/` | Launch Chromium with `--remote-debugging-pipe`, frame and route CDP messages |
| `src/browser/` | Browser and tabs; agent tabs open in their own unfocused window so input reaches them |
| `src/page/snapshot.ts` | Accessibility-tree snapshot with refs, fetched lazily near the viewport |
| `src/page/actions.ts` | Click, type, select, press, scroll, hover, upload, wait, back |
| `src/page/screenshot.ts`, `repl.ts` | Masked screenshots, coordinate clicks, guarded JavaScript |
| `src/agent/` | Tools, permission modes, audit log, the task loop and system prompt |
| `src/models/` | Adapters (Responses, Anthropic, Chat Completions), providers and sign-in, model capabilities, task roles, image generation, and `registry.ts`, the API Settings → Models calls |
| `src/config/` | Keychain access and the encrypted settings store |

## Rules this code keeps

- No TCP debugging port, ever.
- Saved secrets never reach a model: secret fields read as `••••` in snapshots, are covered in screenshots and cannot be read from the REPL.
- Sends, posts, deletes and uploads wait for approval in Guard mode; payments and password changes always wait.
- Every action is written to the audit log.
