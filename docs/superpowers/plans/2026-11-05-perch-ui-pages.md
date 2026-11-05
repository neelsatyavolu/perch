# Perch's own pages (ui-pages)

**Spec:** sections 5.5, 5.9, 6, 7.3, 7.5, 8, 10. **Look:** `DESIGN.md` and `docs/design/perch-preview.html`.

## Goal

Build the WebUI pages Perch adds besides the chat: the new tab page, Settings, the Memory page (with "Set up your memory" and its review), the Routines page, the Import wizard and the welcome screen. They live in `ui-pages/`, a Preact + TypeScript + Vite package separate from the chat UI. Every page talks to one typed client interface (`ui-pages/src/api.ts`). perchd's app API will implement it; until then a fake in-memory backend stands in, and the same interface has an RPC adapter so perchd only has to answer `call(method, args)`.

## Aside parity checklist (this area)

| Aside | Perch | Status in this plan |
|---|---|---|
| New tab: search box with Search / Ask toggle | Address box, Search \| Ask control, `Tab` for Google, `⌘↵` to ask | build |
| New tab: chat rail with New chat, Search chats, recents | Collapsible 200px rail, remembered | build |
| New tab: recent chats and routines | Chats / Routines switcher, three recent cards | build |
| New tab: suggested tasks (set up memory, find routines, import) | Suggested cards that disappear when done and turn into tasks after setup | build |
| Hide parts of the new tab page | Each section can be hidden and shown again | build (Aside cannot) |
| Settings → Models with sign-in state and task models | Providers, API keys, Default / Fast / Standard / Deep / Visual / Image generation with effort and fast mode | build |
| Settings → Skills / MCPs | List, switch, add server, add skill, import from Claude Code, Codex, Claude Desktop, Cursor, Grok with a preview | build; secrets shown only as names that move to the Keychain |
| Permission modes | Ask / Guard / Skip confirmation, per-site rules, per-client rules list | build |
| Memory page and "Set up your memory" | Sources with switches (web search off by default), build progress, review grouped by About you, People, Places and accounts, Writing style, Sites; nothing saved before "Save to memory" | build |
| Memory browsing and editing | Browse pages by folder, edit, delete, pause extraction, wipe | build |
| Routines | List, create, edit schedule, pause, run now, delete, "Find routines to automate" proposals approved one by one | build |
| Import from other browsers | Wizard: pick browser and profile, pick data, see which steps need Full Disk Access or a Keychain prompt first, progress, result | build |
| Onboarding | Welcome: theme, model sign-in, import, memory, each skippable | build |
| — | Privacy and security (content blocker, cookie banners, tracking parameters, HTTPS-only, DoH, fingerprinting, site data) | build (Aside has none of these) |
| — | Five themes, five accents, Match system, hide chrome, density | build |
| — | About and updates (versions, check for updates, automatic updates) | build |

## File layout

```
ui-pages/
  package.json, tsconfig.json, vite.config.ts, bunfig.toml
  newtab.html settings.html memory.html routines.html import.html welcome.html
  src/api.ts                 the typed client interface, documented
  src/api/fake.ts, seed.ts   in-memory backend and its sample data
  src/api/rpc.ts             PerchApi over a call(method, args) transport
  src/api/resolve.ts         picks the native bridge, or the fake in dev and tests
  src/theme/tokens.ts        the one token file: five themes, five accents, state colours
  src/theme/apply.ts         sets the tokens on the page; Match system, Increase Contrast
  src/styles/*.css           base, controls, per-page styles
  src/ui/*.tsx               icons, switch, segmented control, select, dialog, rows, mark
  src/pages/<page>/*.tsx     one folder per page
  src/entries/*.tsx          one entry per page, so each page loads only its own code
  test/unit, test/components component tests in happy-dom
  test/smoke                 builds the pages and loads each one in headless Chrome for Testing in every theme
```

## Tasks

1. Package scaffold, tokens and theme application, with contrast tests that check DESIGN.md's AA claims.
2. `api.ts` interface, the fake backend and the RPC adapter, with unit tests.
3. Shared controls (switch, segmented control with arrow keys, select/listbox, dialog with focus trap and Escape, live region), with keyboard tests.
4. New tab page.
5. Settings shell (nav, search across every row) and its sections: Appearance, Models, Skills and MCP, Permissions, Privacy and security, Memory, Routines, Import, About and updates.
6. Memory page: browse and edit, and the setup flow with its review.
7. Routines page.
8. Import wizard.
9. Welcome screen.
10. Smoke test: every page in every theme in headless Chrome for Testing, no console errors, landmarks present, theme tokens applied.
11. Unslop pass against the checklist; README for the package.

## Deferred, and why

- **Wiring into Chromium** (the `perch://` WebUI data sources, packing the build output into the browser): needs the shell plan (2) and a Chromium build, which this track must not run.
- **perchd's implementation of the app API**: perchd's app-facing endpoint does not exist yet. The interface and an RPC adapter are ready for it; the fake backend shows the expected behaviour.
- **Real sign-in flows** (OAuth windows for ChatGPT and Grok, Claude Code detection): perchd owns them; the pages call `signIn(provider)` and show the state it returns.
- **Full-page chat and the sidebar**: the chat UI track.
- **Remote control, Developers, General settings**: other tracks (spec 9.3, 12); the Settings nav is built so sections can be added.
