# Perch: design

Date: 2026-11-02. Owner: Neel. Status: draft for owner review.

Perch is a fast, private, open-source AI browser for macOS. It is a Chromium fork, so every Chrome extension works. An agent in the right sidebar can use any website you are logged into, with your own ChatGPT/Codex, Claude or Grok subscription. Outside agents (Claude Code, Codex, Grok Bot, agterm tabs) can drive it through a CLI and an MCP server.

Aside (aside.com) is the main reference. Perch copies what Aside gets right (a real Chromium browser, an agent that finishes tasks, local memory, site skills, a CLI and MCP) and differs in four ways: it is open source (MIT), it has no paid plan, it uses the owner's design system, and Lulltab and Backrow are built in.

Name: **Perch**, a place you sit and watch from. Domain: `perchbrowser.com` (free on 2026-11-02, not yet bought). Every common English word of 4 to 8 letters has a registered .com, so the bare name was never available; Arc (arc.net), Dia (diabrowser.com) and Zen (zen-browser.app) do the same thing.

Items marked **[builder call]** were decided by Claude during design, not by the owner. The owner can overturn any of them.

---

## 1. Why

The owner uses Aside daily. They want the same capability in a browser they control: their own look, their own tools built in, no subscription, and data that stays on their Mac or is end-to-end encrypted when it leaves.

## 2. Goals

1. **Real Chromium.** Chromium fork. Chrome Web Store extensions install and run unchanged.
2. **A strong browser agent.** It finishes multi-step tasks on live, logged-in sites. It is measured on the same three benchmarks Aside publishes (section 12).
3. **Bring your own model.** Codex and Grok subscriptions through `shared-ai-auth`. Claude through the user's installed Claude Code, or a Claude API key (section 6.3).
4. **Usable by other agents.** `perch` CLI, an MCP server, and one-command skill install for Claude Code, Codex and Grok. Grok Bot, which runs on xAI's cloud computer, can drive Perch on the owner's Mac through an encrypted relay.
5. **Memory like Aside's.** Agents pull durable facts out of chats and browsing into local markdown memory. A nightly pass consolidates it. Search runs on a local embedding model.
6. **Lightweight and fast.** A configurable memory saver built from Lulltab. No Google background services. Measurable targets in section 11.
7. **Private and secure by default.** Local first. Everything Perch stores is encrypted at rest. Sync is opt-in and end-to-end encrypted. True incognito. Detailed permission modes for agents.
8. **Easy to switch to.** Import from Aside, Chrome, Safari, Arc, Dia, Brave, Edge, Vivaldi, Opera, Firefox, Zen and Helium, including the tabs that were open.
9. **The owner's look.** UI follows `~/DESIGN.md` ("Blackletter" v2: near-black canvas, Geist / Geist Serif / Geist Mono, one blue accent `#4C8DFF`, light mode inverts). Themes are selectable.

## 3. Non-goals (v1)

- Windows, Linux, iOS or Android builds.
- Cloud-hosted agents. Aside offers a cloud "host"; Perch always runs on the user's Mac.
- A hosted model proxy, paid plans or usage billing.
- Training or hosting our own models.
- Intel Macs. macOS 27 runs only on Apple silicon, so Perch ships arm64 only.

## 4. Anti-goals

The project has failed if any of these are true, even when everything else works:

- Browsing data, memory, chats or credentials leave the Mac unencrypted, or reach any server Perch runs in readable form.
- The model ever sees a saved password, card number or one-time code value.
- Perch sends telemetry without opt-in.
- Perch feels slower than Chrome of the same version on the same Mac.
- A popular Chrome extension that works in Chrome breaks in Perch.
- The agent sends a message, posts, pays or deletes something without approval in any mode except the explicit "skip confirmation" mode, and payments always wait for approval even then.

## 5. The browser shell

### 5.1 Engine and build

- Chromium, pinned to the current Stable tag. Our changes live as a patch series plus added source directories, applied by script to a clean checkout (the Brave/Helium approach). This keeps each Chromium update a rebase of known patches. **[builder call]**
- We rebase on every Chromium Stable release (about every 4 weeks) and ship security point releases within a few days of Google's.
- Privacy patches: remove or disable Google services that phone home (sync to Google, Safe Browsing pings that send URLs, optimization guide downloads, on-device model downloads, field trials, usage stats, Google sign-in). Borrow patches from ungoogled-chromium and Helium where licences allow, credited. Keep the Chrome Web Store working; ungoogled-chromium's way of breaking it is not acceptable.
- Safe Browsing: keep local list-based protection (hash-prefix updates), drop real-time URL checks. **[builder call]**
- **Allowed background connections** **[builder call]**. Only these, each listed in Settings → Privacy with an off switch: extension updates from the Chrome Web Store; Safe Browsing list updates; Chromium component updates limited to CRLSets, certificate data and the Widevine CDM; one Sparkle update check per day to GitHub; sync and relay when the user turned them on. Everything else Google-bound is patched out. Extensions that rely on `chrome.identity.getAuthToken` (Google sign-in through Chrome) will not work, as in every non-Google Chromium; this is accepted and listed in the docs.
- Build machine: the owner's M5 Max (64 GB RAM, about 351 GB free). A full checkout plus build is about 100 GB; a first build takes 2 to 3 hours. CI builds on GitHub-hosted macOS runners are too slow for full builds; release builds happen locally or on a rented Mac. **[builder call]**
- Signing and updates follow agterm: Developer ID from 1Password, notarized, Sparkle updates from GitHub Releases (`appcast.xml`), EdDSA key in 1Password.
- Bundle id `co.xanom.perch`. URL scheme `perch://` for internal pages, with `chrome://` aliases kept so extensions and docs still work.

### 5.2 Widevine (DRM) — a real risk

Netflix, Hulu, Disney+, Prime Video, Peacock and HBO Max need Google's Widevine CDM. Backrow's main use is exactly those sites. Plain Chromium builds do not include Widevine, and a browser has to be accepted into Google's Widevine programme to ship it (Brave, Vivaldi and Arc are). Action: the owner applies to Google in their own name at the start of the project (owner's decision). Google may turn down an individual; if so, revisit applying through a company. **1.0 ships without Widevine if approval has not arrived** (owner's decision): YouTube and Backrow's own-file streaming work, the DRM sites do not, and the UI says so plainly instead of failing silently. DRM support comes in a later update.

### 5.3 Window layout

Taken from the owner's Aside screenshots.

- **Top bar**: horizontal tabs (Chromium's own tab strip, restyled), `+` button, and the profile button on the right edge with an avatar and a chevron.
- **Profile menu**: the profile list with a check on the current one and `⋯` for options, "New profile", then Bookmarks ›, Downloads ›, Extensions ›, History ›, Developers ›, Settings (⌘,), New Tab (⌘T), Incognito Window (⇧⌘N).
- **Hide chrome**: one shortcut and a setting hide the tab strip and bookmarks bar completely. The address bar appears on ⌘L and a tab switcher on ⌃Tab. Top-edge hover can reveal the bar, as a setting.
- **Split view**: two tabs side by side in one window, with a draggable divider. Built on Chromium's split-view feature where it exists, extended to work from the tab context menu and a shortcut.
- **Right sidebar**: the agent chat (section 6.6). Toggled with a toolbar button and a shortcut. Resizable. It remembers per-window state.
- **Themes**: Ink (dark, default) and Paper (light) from DESIGN.md, plus Graphite, Contrast and Dusk to match agterm's theme set. Themes drive both the native chrome and the WebUI pages through one token file.

### 5.4 UI technology

- Native chrome (tab strip, toolbar, profile button, split view) stays C++ Views and is restyled through patches and theme colours. Moving it to web tech would cost speed. **[builder call]**
- Everything Perch adds (sidebar chat, full-page chat, artifacts pane, settings pages, memory and skills managers, import wizard, new tab page) is WebUI: TypeScript + a light framework (Preact or Lit), loaded lazily so a window without the sidebar costs nothing. **[builder call]**

### 5.5 Address bar and search

- Default search: Brave Search.
- Pressing **Tab** in the address bar while typing a query switches that query to Google; a chip shows "Google", and Tab again or Backspace switches back. This replaces Chromium's tab-to-search keyword behaviour for those two engines. Other keyword engines keep working.
- The address bar can also start an agent chat ("Ask"), like Aside's Search / Ask toggle, with ⌘Enter. **[builder call]**

### 5.6 Memory saver (built from Lulltab)

Lulltab (`~/Documents/GitHub/still`, public, MIT) is an extension that sleeps idle tabs using Chromium's native tab discard. Perch moves its logic into the browser (C++ or a built-in component extension, **[builder call]**) and keeps its settings:

- sleep after a timeout (default 15 minutes, configurable, or off)
- whitelist patterns: `github.com` (domain and subdomains), `=host` (exact host), `*.host` (subdomains only), `host/path` (path and below), full URL prefixes
- never sleep pinned tabs, tabs playing audio, tabs with an active agent task, or browser pages
- right-click "Sleep this tab" / "Never sleep this site"; `Alt+Shift+S` sleeps the current tab
- a Memory page showing RAM per loaded tab and which tabs are asleep
- sleeping tabs look dimmed in the tab strip and wake when clicked

Chromium's own Memory Saver UI is replaced by this one so there is only one setting.

### 5.7 Backrow built in

Backrow (`~/Documents/GitHub/backrow`, public, MIT) ships as a built-in component extension that cannot be uninstalled but can be turned off. It updates with Perch releases. Its server stays `backrow.n3el.dev`. Perch adds a "Start watch party" item to the tab menu on supported sites.

### 5.8 Profiles and incognito

- Profiles are Chromium profiles with Perch's menu. Each profile has its own agent memory, chats, skills, model logins and permission settings. Nothing is shared across profiles.
- **True incognito**: everything in memory, no disk cache, no history, no memory extraction, no session restore, downloads only where the user saves them. The agent can be used in incognito but cannot read or write memory, and its chat is discarded when the window closes. Extensions are off in incognito unless allowed per extension (Chromium default).

## 6. The agent

### 6.1 Processes

- **`perchd`**: a local daemon started by the browser, written in TypeScript and compiled to one binary with Bun. **[builder call]** It runs the agent loop, model connections, memory, skills, the MCP server, the CLI endpoint and the relay client. It shuts down with the browser unless remote control is on.
- `perchd` controls the browser through the Chrome DevTools Protocol over a private pipe (`--remote-debugging-pipe`), never a TCP port. Browser-only features (credential fill, approval prompts, tab ownership) go through a small set of custom CDP domains added by our patches. **[builder call]**
- The CLI and the MCP server reach `perchd` through a Unix socket in the user's Application Support folder, mode 0600, with a per-client token.

### 6.2 How the agent sees and acts on pages

- **Page snapshot**: a compact text view built from the accessibility tree plus visible text. Interactive elements get short refs (`e12`). Key content comes first, and the output is kept small (Aside reports theirs as 70% smaller than agent-browser's). This is the main input.
- **Actions**: navigate, click(ref), type(ref, text), select, scroll, hover, press key, upload file, wait for, go back, open/close/switch tabs, read PDF, download.
- **Fallback**: screenshots with coordinate clicks (computer use) when the snapshot cannot express the page (canvas apps, maps).
- **REPL**: a Playwright-style JavaScript tool for bulk extraction and scripted steps, as in `aside repl`.
- **Agent tabs**: the agent works in background tabs grouped under an "Agent" tab group, so it never steals focus from the tab the user is on. The user can watch any agent tab live.
- **Logins**: when a site needs a login, the agent asks the browser to fill credentials from Perch's password manager. The browser fills the fields directly. The model sees only "filled" or "no saved login". The same applies to one-time codes and payment cards.
- **What "never sees a secret" covers** **[builder call]**: values Perch fills from its own stores (passwords, cards, saved one-time codes, passkeys). After a fill, those fields are redacted in snapshots, masked in screenshots, and blocked from REPL reads (the REPL cannot read `value` of password, card or OTP-autocomplete fields). Codes the user asks the agent to fetch from their own email or Messages are not covered: reading the user's mail on request is a normal task, and the approval rules in 6.4 still apply.
- **Bot challenges**: Perch is a real browser with a real profile, so most sites treat it as a person. When a CAPTCHA appears, the agent pauses and asks the user.

### 6.3 Models and sign-in

| Provider | How | Notes |
|---|---|---|
| ChatGPT / Codex subscription | OAuth through `@neelsatyavolu/shared-ai-auth` (Codex flow) | Model list from the package's `models.json`. |
| Grok subscription | OAuth through `shared-ai-auth` (Grok flow) | |
| Claude subscription | Perch runs the user's installed Claude Code CLI headless (`claude -p --output-format stream-json`) with Perch's browser tools attached over MCP | Claude Code owns the login and the agent loop. Perch never reads or copies Claude Code's tokens. |
| Claude API key | Perch's own agent loop against the Anthropic API | For users without Claude Code. |

The Claude choice is deliberate. Aside copies Claude Code's OAuth tokens into its own agent. Anthropic's terms do not allow third-party apps to use a Claude.ai subscription login that way, and a public MIT repo would make it obvious. With Claude Code as the runner, Claude users get the subscription without breaking the terms. The cost is that the Claude path uses Claude Code's agent loop and system prompt, so it will be heavier than Perch's own loop; the benchmark runs will show by how much. **[builder call, confirmed in principle by the owner: "make it possible"]**

Tokens are stored in the macOS Keychain, scoped to Perch's code signature. The model picker shows provider, model, effort (off → max) and a fast toggle, as in the screenshot.

### 6.4 Permission modes

Per chat, with a profile default. Shown at the bottom left of the composer.

- **Ask**: every action that changes something waits for approval. Reading and navigating do not.
- **Guard** (default): reading, navigating, searching and filling forms run freely. Approval is needed to submit anything that sends, posts, buys, books, deletes, changes account settings or shares, plus file access outside the chat's folder, downloads that run, and credential fill on a site for the first time.
- **Skip confirmation**: runs without asking. Payments, purchases and password changes still wait for approval.

On top of the mode:

- per-site rules: always allow, always ask, never touch (for example, never act on a bank site)
- per-client rules for outside agents: the CLI, each MCP client and the relay get their own mode, Guard by default
- an audit log of every agent action: time, tab, site, action, which client, and whether it was approved; viewable and exportable in Settings
- approval cards show exactly what will be sent (the message text, the order total) before the user approves

### 6.5 Skills

- The skill format is the same `SKILL.md` format Claude Code uses (frontmatter name + description, markdown body, optional scripts), so skills move between Perch, Claude Code and Codex.
- **Built-in site skills** (read on demand, like Aside's): Google Account, Gmail, Google Docs, Sheets, Slides, Drive, Calendar, Search; Outlook and Microsoft 365; Slack; Discord; Notion; GitHub; Linear; Jira; Figma; X; Reddit; LinkedIn; YouTube; Instagram; WhatsApp Web; Amazon; Airbnb; Google Maps; Canvas LMS; Messages (iMessage, read and send through the local Messages database and AppleScript, with Full Disk Access the user grants); plus file skills: PDF, DOCX, XLSX, PPTX.
- Where a site has a stable web API reachable with the user's logged-in session, the skill uses it so tasks run without opening a tab (Aside's Gmail and Docs skills work this way).
- **My skills**: import from a folder, a URL or a git repo. Shown in a Skills / MCPs settings page like Aside's.
- **MCP client**: users can add MCP servers that the Perch agent can call.

### 6.6 Chat UI

**Sidebar** (screenshot 1): header with chat title and a menu of recent chats, new-chat and close buttons. Empty state shows the Perch mark. The composer shows a chip for the current tab (favicon, title, domain); `@` adds other tabs, files, memory or skills as context; `+` attaches files; a microphone button dictates with macOS on-device speech recognition. Under the composer: permission mode, which tabs the agent may use (current tab / all tabs / new agent tabs), and the model + effort picker.

**Full-page chat** (screenshot 7): opened from the chat menu or a `perch://chat` tab. Left: chat list (toggleable). Centre: the conversation. Right: the artifacts pane. Header: title (editable), `⋯`, Share (exports to a file; there is no hosted share), and pane toggles.

**Message rendering**: a streaming markdown parser that handles partial input without flicker; headings, lists, tables, links, code with syntax highlighting, math, and inline citations to the tabs and pages the agent used. Tool steps ("Opened gmail.com", "Clicked Send") collapse into one expandable line per turn. Each reply has copy, branch and timestamp, as in the screenshot.

### 6.7 Artifacts

- The agent can make artifacts: HTML pages, React components, SVG, Mermaid diagrams, markdown documents, and data files (CSV, JSON).
- In the full-page chat they open in the right pane; in the sidebar they open in a new tab. Versions are kept per artifact.
- They render in a sandboxed origin (`perch-artifact://<id>`) with no access to cookies, the profile or other tabs, and no network except an allowlist of CDNs. The user can save one to disk or open it as a tab.

## 7. Memory

Modelled on how Aside stores memory on this Mac (`~/.aside/u/0/memory/`):

- **Storage**: markdown files per profile. Top-level `MEMORY.md` (agent operating rules) and `USER.md` (stable facts about the user), both kept small enough to load into every chat. Topic pages under `users/`, `people/`, `companies/`, `sites/`, `projects/`, `routines/`, `concepts/`, each with frontmatter plus "Current" and "History" sections. `episodic/` holds append-only dated entries. A `TAXONOMY.md` holds the filing rules.
- **Extraction**: after each chat, a small model call extracts durable facts and files each one in exactly one place. Browsing history extraction (which sites the user uses for what) is opt-in and runs locally on a schedule.
- **Dreaming**: a nightly consolidation pass merges duplicates, updates "Current", moves stale facts to "History" and writes a dated log the user can read.
- **Search**: SQLite FTS5 plus vectors from a small local embedding model run with onnxruntime; no text leaves the Mac for indexing.
- **Control**: a Memory page to browse, edit and delete anything, pause extraction, or wipe memory. Incognito never reads or writes memory.
- **Which model extracts**: the profile's "fast" model on whatever provider is signed in. The user can turn extraction off entirely.

## 8. CLI, MCP and outside agents

### 8.1 `perch` CLI

Modelled on `aside`:

```
perch [prompt]                    run a task (or open a URL)
perch exec [--host H] [--model M] [--effort E] [--permission MODE] "<task>"
perch repl "<js>"                 Playwright-style JS in Perch
perch tabs | open | snapshot | click | type | screenshot   one-shot browser commands
perch memory search|read          read-only memory access
perch skills list|show|install
perch login | logout | host list | host use H    remote control
perch mcp                         stdio MCP server for agent clients
perch skill install claude|codex|grok   install the Perch skill + MCP config
```

### 8.2 MCP server

Tools: `exec` (hand a whole task to Perch's agent), `repl`, `tabs`, `snapshot`, `act` (click/type/etc. by ref), `screenshot`, `memory_search`, `browser_profiles`. These are the same tools Aside exposes (`mcp__aside__exec`, `repl`, `memory_search`, `browser_profiles`) so existing prompts carry over. Every call goes through the permission system as that client.

### 8.3 Grok Bot and remote control

Grok Bot runs on xAI's cloud computer, not the owner's Mac. Aside handles this with "Remote Control": the bot installs the Aside CLI, logs in with an 8-character code the user approves in Settings, then runs `aside exec --host <device>` through Aside's relay. Perch does the same:

- **Settings → Developers → Remote Control**, off by default.
- A relay on Cloudflare (Worker + Durable Object per device, WebSocket). The remote CLI and the Mac exchange keys at pairing, and every message is end-to-end encrypted between them, so the relay only passes ciphertext.
- `perch login --email` shows a code; the user approves it in Perch, which names the device and the permission mode it gets (Guard by default).
- Settings shows a ready-to-paste connection prompt for Grok Bot (and other cloud assistants), like Aside's.
- A remote MCP endpoint over the same relay, for assistants that take an MCP connector URL. The URL carries a revocable token.
- Every remote device is listed with last use, and can be revoked.

### 8.4 agterm and the owner's other apps

The owner was unsure what agterm could add. **[builder call]**:

- agterm already injects MCP servers (consult, memory) into the `claude`/`codex` it launches. Add Perch's MCP server to that list when Perch is installed, so every agent tab in agterm can use the browser.
- Links clicked in agterm open in Perch when Perch is the default browser (no special work).
- `perch skill install` covers Claude Code, Codex and Grok outside agterm.
- Lulltab and Backrow are built in (sections 5.6, 5.7).

## 9. Import

A first-run wizard and a Settings page. For each browser found on the Mac, the user picks what to bring:

| Data | Chromium family (Chrome, Arc, Dia, Brave, Edge, Vivaldi, Opera, Helium, Aside) | Safari | Firefox / Zen |
|---|---|---|---|
| Bookmarks | yes | yes | yes |
| History | yes | yes (Full Disk Access) | yes |
| Passwords | yes (macOS asks to unlock that browser's Keychain item) | via the CSV export from Safari/Passwords app | yes (needs no primary password, or the user enters it) |
| Cookies / logins | yes (same Keychain prompt) | yes (Full Disk Access) | yes |
| Open tabs and windows | yes, from the last session files | yes (Full Disk Access) | yes, from the session store |
| Extensions | reinstalled from the Chrome Web Store by id | no | no |
| Search engine, settings | where they map | no | no |

**Open tabs**: imported windows reopen as they were, with tab order, pinned tabs, tab groups and split views where the source has them (Arc spaces become tab groups). Tabs open asleep and load when clicked, so importing 300 tabs does not freeze the Mac.

**From Aside, additionally**: memory files, user skills, chat history (from `~/.aside/u/<n>/state.db` and `sessions/`), permission mode and model preferences. Model logins are not copied; the user signs in again. That avoids moving tokens between apps.

The wizard says which steps need Full Disk Access or a Keychain prompt before asking for them.

## 10. Account, sync and encryption

### 10.1 At rest on the Mac

- Chromium's own stores (cookies, passwords, cards) use Chromium's encryption with a "Perch Safe Storage" Keychain key, as Chrome does.
- Perch's own data (memory, chats, skills, artifacts, audit log, model tokens) is encrypted with AES-256-GCM using a per-profile key. That key is wrapped by a Secure Enclave key, so it cannot be copied off the Mac. **[builder call]**
- Memory and skills are still markdown, just encrypted on disk. People and agents read and edit them through Perch: the Memory and Skills pages, `perch memory` / `perch skills`, and the MCP server (which is how the Claude Code path reads them). `perch skills export <dir>` writes plain `SKILL.md` folders for use in Claude Code or Codex, and `perch skills install` reads them back. **[builder call]**
- Moving to a new Mac: a Secure Enclave key does not survive Migration Assistant or a Time Machine restore. At setup Perch creates a recovery key (the same one sync uses) and offers an encrypted export file. With sync on, a new Mac just pairs. Without sync, the export file plus the recovery key restores everything. Perch tells the user this at setup. **[builder call]**
- Optional Touch ID lock for passwords, memory and chats, as a setting.

### 10.2 Account

- Optional. Perch works fully without one.
- Sign-in with email and a passkey; email codes sent through Resend as a fallback, as the owner's other n3el/xanom apps do. **[builder call]**
- The account exists only to hold encrypted sync data and the list of paired devices.

### 10.3 Sync (opt-in, end-to-end encrypted)

- Browser data (bookmarks, history, passwords, open tabs, settings, extensions list) uses Chromium's built-in sync engine pointed at Perch's own server, with Chromium's client-side passphrase encryption always on. This is the model Brave Sync uses with its open-source server (`brave/go-sync`). Perch's server implements the same protocol on Cloudflare Workers + D1 + R2. **[builder call]**
- Perch's own data (memory, skills, chats, artifacts) syncs as encrypted blobs through the same account.
- Keys: the sync key is created on the first device. A new device joins by scanning a code on a device that already has the key, or by entering a recovery key the user saved at setup. Perch has no way to recover data without one of those, and says so at setup.
- The server stores ciphertext, sizes, timestamps and device ids. It cannot read anything.
- Each data type can be switched on or off separately.

### 10.4 Who the server is for

Owner's decision: **everyone, free, with limits.** Anyone who downloads Perch can use the hosted sync and relay. Each account gets a storage cap and rate limits sized so the service stays within Cloudflare's free and low-cost tiers (exact numbers are the builder's call, set from measured usage). Accounts that hit the cap are told, not cut off silently. A one-command self-host deploy of the same Worker is documented for people who want their own server. The server needs abuse limits on sign-up, pairing and relay traffic from the start.

### 10.5 Telemetry

None by default. An opt-in anonymous daily ping to `analytics.n3el.dev` (random install id, Perch and Chromium version, CPU type), the same contract as Lulltab. **[builder call]**

## 11. Speed and weight targets

Measured on the owner's Mac against Chrome of the same Chromium version, with the same extensions:

- Speedometer 3 and JetStream within 2% of Chrome.
- Cold start to a usable window no slower than Chrome.
- Idle memory of Perch's additions (sidebar closed, `perchd` idle) under 60 MB.
- With the window idle and sync off, a packet capture shows no requests outside the allowed list in 5.1, and none at all with every item on that list switched off.
- With 100 tabs open and the memory saver at default, total memory at least 50% lower than Chrome without a saver.

## 12. Benchmarks

Run the three suites Aside publishes (`github.com/at-inc/aside-benchmarks`):

- **Online-Mind2Web**: 300 tasks across 136 live sites.
- **BU Bench V1**: 100 hard tasks drawn from WebBench, Mind2Web 2, GAIA, BrowseComp and interaction tests.
- **Odysseys**: 200 long, multi-site tasks, scored by rubric.

A `bench/` folder holds the runner, which drives Perch through the CLI with a chosen model and records full transcripts. Grading follows each suite's published method. Results are published in the repo in the same format as Aside's, including failures and "impossible" tasks. The target is to match Aside's harness with the same model (Aside reports 99.0% on Online-Mind2Web with GPT-5.5). Treat that as a target, not a promise. Live sites change, so each run records its date.

## 13. Build order

One design, built in this order. Each step ends with something the owner can use.

1. **Fork pipeline**: checkout, patch series, branding, signed and notarized build, Sparkle updates. Apply for Widevine now.
2. **Shell**: theme, restyled tabs and profile menu, hide-chrome mode, split view, Brave + Tab-for-Google, privacy patches, true incognito, built-in memory saver and Backrow.
3. **Agent**: `perchd`, page snapshot and actions, sidebar chat, Codex/Grok/Claude sign-in, permission modes and audit log, credential fill, full-page chat and artifacts.
4. **Outside agents**: CLI, MCP server, skill installers, agterm hook-up, built-in site skills.
5. **Memory**: storage, extraction, dreaming, local search, Memory page.
6. **Import**: all browsers, open-tab restore, Aside extras.
7. **Account, sync and relay**: server on Cloudflare, E2E sync, remote control, Grok Bot.
8. **Benchmarks and speed**: the three suites, the targets in section 11, public results, then a 1.0 release and the site at `perchbrowser.com`.

## 14. Constraints

- Chromium is BSD-licensed; Perch's own code is MIT. Patches borrowed from other forks keep their licences and credits.
- Anthropic's terms rule out reusing Claude Code's tokens; see 6.3.
- `shared-ai-auth` supports Codex and Grok only. It must be used as-is or extended in its own repo.
- Widevine needs Google's approval; see 5.2.
- macOS only, Apple silicon only.
- One developer plus agents. The Chromium rebase every four weeks is ongoing work, not a one-time cost.
- Owner rules that apply: don't drive the GUI with osascript or screen capture while the owner is using the Mac (agterm lesson); verify with tests, logs and off-screen checks; never print or store secrets.

## 15. Left to the builder

- Exact patch boundaries and which Chromium features to reuse versus write.
- The WebUI framework choice within "light and lazy".
- The snapshot format details and the agent's prompts, judged by benchmark results.
- The embedding model, as long as it runs locally and is small.
- The wording of every UI string, following `~/ANTI AI WRITING.md`.
- The list of built-in skills beyond those named, by popularity.
