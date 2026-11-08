# ui-pages

Perch's own pages, apart from the chat: the new tab page, Settings, Memory (with "Set up your memory" and its review), Routines, the Import wizard, the welcome screen and the command bar (⌘K). Preact + TypeScript, built with Vite into one HTML file per page so each page loads only its own code.

## Develop

```sh
bun install
bun run dev            # pages with sample data from the fake backend
bun run typecheck
bun run test:unit      # unit and component tests in happy-dom
bun run test:smoke     # builds with the fake backend, loads every page in every theme in headless Chrome for Testing
```

The smoke test uses perchd's pipe launcher, so it needs the same Chrome for Testing install as perchd (see `perchd/README.md`). It never opens a window.

In a `--mode fake` build, `?theme=paper&accent=green` picks the look and `welcome.html?welcome` starts onboarding from the first step.

## How a page gets its data

Every page talks to one typed interface, `PerchApi` in `src/api.ts`. The comments there are the contract perchd implements.

- In Perch, the browser injects `window.perch = { call(method, args), subscribe(event, listener) }` into these pages only. `src/api/rpc.ts` turns it into a `PerchApi`: one call per method, named as in `api.ts`, with the arguments as an array. Job progress arrives as `job:<jobId>` events.
- In development and tests, `src/api/fake.ts` answers from memory with the sample data in `src/api/seed.ts`.
- A production build never falls back to sample data. Without the bridge, the page says perchd isn't running.

Secret values (API keys, MCP env and header values) go in through the API and never come back out. Read methods return only their names; perchd keeps the values in the Keychain.

## Layout

| Path | What |
|---|---|
| `src/api.ts` | The app API interface |
| `src/api/` | Fake backend, sample data, RPC adapter, backend picker |
| `src/theme/tokens.ts` | The one token file: five themes, five accents, state colours |
| `src/theme/apply.ts` | Sets the tokens on the page; Match system and Increase Contrast |
| `src/styles/` | Base, controls and frame styles |
| `src/ui/` | Shared controls: switch, segmented control, tabs, dialog, rows, progress, icons |
| `src/pages/<page>/` | One folder per page |
| `src/entries/` | One entry per page |
| `test/unit`, `test/components`, `test/smoke` | Tests |

## Accessibility

Every control works from the keyboard: arrow keys move through segmented controls, tabs and lists, Escape closes dialogs, Tab and Shift+Tab wrap inside them while open, and closing one returns focus to the control that opened it (component tests, plus a headless Chrome check in the smoke test). Focus rings use the accent, as `DESIGN.md` describes. Reduce Motion turns off transitions. Icon buttons have names for VoiceOver, and job steps and confirmations are announced as status messages.

## Not here yet

- Serving these pages at `perch://` URLs inside the browser (needs the browser shell and a Chromium build).
- perchd's side of the app API. The fake backend shows what each method should do.
- The full-page chat and the sidebar, which are the chat UI's.
