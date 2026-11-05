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

Add `--show` to watch the browser and `--mode ask|guard|skip` to change the permission mode (Guard by default). Codex and Grok need the sign-in that Perch's settings add later.

## Layout

| Path | What |
|---|---|
| `src/cdp/` | Launch Chromium with `--remote-debugging-pipe`, frame and route CDP messages |
| `src/browser/` | Browser and tabs; agent tabs open in their own unfocused window so input reaches them |
| `src/page/snapshot.ts` | Accessibility-tree snapshot with refs, fetched lazily near the viewport |
| `src/page/actions.ts` | Click, type, select, press, scroll, hover, upload, wait, back |
| `src/page/screenshot.ts`, `repl.ts` | Masked screenshots, coordinate clicks, guarded JavaScript |
| `src/agent/` | Tools, permission modes, audit log, the task loop and system prompt |
| `src/models/` | Responses API (Codex, Grok), Anthropic Messages API, a scripted fake |
| `src/memory/` | Encrypted memory pages (key in the Keychain), in-RAM FTS5 search, extraction, dreaming, "Set up your memory", memory tools, Memory page API |
| `src/routines/` | Cron schedules, encrypted routines and runs, the unattended runner, the scheduler, Routines API, and `openPerchData` that wires it all |

## Rules this code keeps

- No TCP debugging port, ever.
- Saved secrets never reach a model: secret fields read as `••••` in snapshots, are covered in screenshots and cannot be read from the REPL.
- Sends, posts, deletes and uploads wait for approval in Guard mode; payments and password changes always wait.
- Every action is written to the audit log.
- Memory, routines and run chats are AES-256-GCM encrypted per record; the search index lives only in RAM. Passwords, keys, card numbers and codes are never saved as memories.
- Scheduled routines decline anything that needs approval, so they never pay, send or delete unattended.
