# Perch plan: chat UI and the app API

**Goal:** Perch's own pages can run the agent. `perchd` gets a local app API (HTTP + WebSocket, per-launch token, origin-checked) that keeps chats encrypted on disk, streams runs, holds approvals, binds side chats to tabs and serves artifacts from an isolated origin. A new `ui/` package (Preact + TypeScript + Vite) draws the right sidebar chat and the full-page chat in all five themes and five accents, matching `docs/design/perch-preview.html`.

**Spec:** sections 5.3 (side chats belong to a tab), 5.4, 6, 7.4 (approval cards), 7.6, 7.7, 11.1. Visual rules: `DESIGN.md`. Approved look: `docs/design/perch-preview.html`.

**Out of this plan:** the Chromium side (WebUI resources, side panel per tab, `perch-artifact://`). This plan ends with a design note for it: `docs/design/webui-hosting.md`.

## Aside parity checklist (chat)

| Aside | Perch, this plan |
|---|---|
| Sidebar chat next to the page | Sidebar page, one side chat per tab (Aside has one per window) |
| Chat list and full-page chat | Full-page chat: list 200px, conversation, artifact pane 360px resizable |
| Streaming replies with tool steps | Text streams over WebSocket; steps collapse into one line per turn |
| Approval before sending | Approval card shows exactly what goes out; the button names the action |
| Stop a running task | Cancel from the composer; the run ends with "Stopped" |
| Model picker with effort | Model + effort picker from the catalog perchd reports |
| Permission modes | Ask, Guard, Skip confirmation, per chat |
| Tab context chip, @ for context | Current-tab chip; scope picker (current tab, all tabs, new agent tabs) |
| Artifacts | HTML, Markdown, code, SVG, CSV/JSON and images, versioned per chat, served sandboxed |
| Copy, branch | Copy a reply, branch from any message, export a chat as Markdown |
| Chats stored on the Mac | Encrypted per record with AES-256-GCM; the key lives in the Keychain |

## File layout

```
perchd/src/app/
  protocol.ts        types shared with ui/ (chats, messages, events, cards); no imports
  keychain.ts        Keychain interface, macOS `security` adapter (secret on stdin), in-memory mock
  vault.ts           per-profile AES-256-GCM key from the Keychain; seal/open with record id as AAD
  chats.ts           encrypted chat store: list, create, update, branch, side-chat binding
  artifacts.ts       encrypted artifact store with versions; artifact blocks parsed from replies
  approval-card.ts   ApprovalRequest -> what the card shows and the confirm label
  transcript.ts      the task text for a turn: earlier turns, tab context, artifact format
  runs.ts            runs per chat: stream events, pending approvals, cancel
  server.ts          HTTP routes + WebSocket hub, token and origin checks (loopback or Unix socket)
  artifact-server.ts isolated origin with a strict CSP for artifacts
  main.ts            development entry: starts the API against a headless test browser
perchd/test/app-*.test.ts

ui/
  package.json tsconfig.json vite.config.ts bunfig.toml
  scripts/gen-tokens.ts   DESIGN.md -> src/styles/tokens.css (the one token file)
  sidebar.html chat.html  page shells; each loads its page lazily
  src/api/                client: fetch + WebSocket with the token
  src/state/              chat state, reducers (immutable)
  src/components/         Icon, PerchDot, Markdown, Message, Steps, ApprovalCard, Composer, pickers, ChatList, ArtifactPane
  src/pages/              Sidebar, FullChat
  test/                   component tests (happy-dom), smoke test in headless Chrome for Testing
```

## Tasks

1. **Plan** (this file). Commit.
2. **Protocol, keychain, vault.** Tests: a sealed record opens; a record moved to another id fails; a tampered byte fails; the key is created once and read back from the mock keychain; the macOS adapter never puts the secret in argv.
3. **Chat store.** Tests: chats survive a reload; files on disk contain no plaintext; updates return new objects; branch copies messages up to a point; side chat lookup by tab, move to another window, unbind on tab close; drafts and scroll positions persist.
4. **Artifacts.** Tests: versions grow; blocks in a reply become artifacts and the reply keeps a reference; kinds are validated; the artifact server sends a strict CSP and `sandbox`, rejects a wrong capability, and serves images with their type.
5. **Approval card and transcript.** Tests: a typed message shows its text; a "Send" click is labelled "Send"; a payment button keeps its amount; generic names ("OK", "Confirm") become `Click "OK"`; uploads list files; earlier turns and the tab context reach the task text.
6. **Runs.** Tests (scripted runner): text streams, steps collect, an approval waits for the user, cancel stops the run, a second message waits for the first run, the reply is saved with its steps and artifacts. One integration test with the real `runTask`, the fake model and headless Chrome for Testing, approving through the API.
7. **Server.** Tests: no token, wrong token and bad origin are refused; a wrong Host is refused (DNS rebinding); CORS only for allowed origins; WebSocket needs the token subprotocol; every route validates input; a Unix socket works.
8. **UI package and tokens.** Generator reads the theme and accent tables from `DESIGN.md`. Tests: every theme and accent is present; Paper uses the light accent shades.
9. **Components.** Tests with happy-dom: Markdown handles unfinished input and never renders raw HTML; the approval card names the action and shows the body; the composer sends, keeps a draft, switches mode, scope and model; the perch dot breathes only while running and is still while waiting; steps collapse; copy and branch call the API.
10. **Pages.** Sidebar: follows the active tab, hides and restores side chats with draft and scroll. Full-page chat: list, conversation, artifact pane with a resize handle (keyboard too), chat list collapses below 1100px.
11. **Smoke test.** Build, start the app API with a scripted runner as the fake backend, load both pages in headless Chrome for Testing in every theme, fail on any console error or exception.
12. **Design note** for the Chromium plan, README updates, full `bun test`, `tsc`, then detach.

## Deferred, and why

- **Agent tab scope "current tab" acting in the user's own tab.** The loop opens its own agent tabs; attaching to the user's tab needs the tab-ownership CDP domain from plan 3b. Here the scope passes the tab's title and URL to the agent, which opens it in an agent tab.
- **A dedicated artifact tool.** Adding a tool touches `tool-specs.ts`, `tools.ts`, `permissions.ts`, `session.ts` and `mcp.ts`, which other tracks are changing. Artifacts use a fenced block format in the reply instead, which works with every model and needs no shared change. A tool can replace it later without changing the store or the UI.
- **Secure Enclave wrapping of the profile key.** Needs a signed app with the right entitlement (plan 3b/8). The key sits in the Keychain now; the vault takes a key source, so wrapping slots in later.
- **Syntax highlighting, math, Mermaid and React artifacts.** Code renders plain with a language label; the rest render as code until a small highlighter is chosen against the bundle budget.
- **Dictation and file attach.** The buttons are in the composer layout but need browser APIs (macOS speech, file chooser) that the Chromium plan provides; they are shown disabled with a reason.
- **`@` mentions of memory and skills.** Memory and skills are other tracks; `@` lists open tabs only for now.
