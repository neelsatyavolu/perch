# ui

Perch's own pages: the right sidebar chat and the full-page chat. Preact and TypeScript, built with Vite, about 20 KB gzipped. They talk to `perchd`'s app API (`perchd/src/app/`).

## Develop

```sh
bun install
bun run build        # regenerates tokens from DESIGN.md, then builds dist/
bun test             # tokens, reducers, components and pages (happy-dom), plus the headless smoke test
bunx tsc --noEmit
```

Try the pages against a real `perchd` with a headless test browser:

```sh
cd ../perchd && bun run src/app/main.ts --mock-keychain
```

It prints the two page addresses with this launch's token in the URL fragment. `--mock-keychain` keeps the data key in memory; without it the key goes in the Keychain item "Perch Data Key".

The smoke test (`test/smoke.test.ts`) builds the pages, starts the app API with a scripted runner, and loads both pages in Chrome for Testing in every theme and accent. It fails on any console error, exception or CSP report. `PERCH_SMOKE_SHOTS=<dir> bun test test/smoke.test.ts` also saves a PNG of each page for the design review.

## Layout

| Path | What |
|---|---|
| `scripts/gen-tokens.ts` | Reads the theme and accent tables in `DESIGN.md` and writes `src/styles/tokens.css` (the one token file) and `src/theme/names.gen.ts` |
| `src/api/` | Page config, the API client (fetch and one WebSocket), shared types from `perchd/src/app/protocol.ts` |
| `src/state/` | Event reducers, the open-chat hook (drafts saved as you type), layout preferences |
| `src/components/` | Markdown, messages and steps, the approval card, composer and pickers, chat list, artifact pane, icons and the perch dot |
| `src/pages/` | `sidebar.tsx` (one side chat per tab) and `full-chat.tsx` |

How the Perch build hosts these pages: `docs/design/webui-hosting.md`.
