# Perch: design

Date: 2026-11-02. Owner: Neel. Status: draft for owner review.

Perch is a fast, private, open-source AI browser for macOS. It is a Chromium fork, so every Chrome extension works. An agent in the right sidebar can use any website you are logged into, with your own ChatGPT/Codex, Claude or Grok subscription. Outside agents (Claude Code, Codex, Grok Bot, agterm tabs) can drive it through a CLI and an MCP server.

Aside (aside.com) is the main reference. Perch copies what Aside gets right (a real Chromium browser, an agent that finishes tasks, local memory, site skills, a CLI and MCP) and differs in four ways: it is open source (MIT), it has no paid plan, it uses the owner's design system, and Lulltab and Backrow are built in.

Name: **Perch**, a place you sit and watch from. Domain: `perchbrowser.com` (free on 2026-11-02, not yet bought). Every common English word of 4 to 8 letters has a registered .com, so the bare name was never available; Arc (arc.net), Dia (diabrowser.com) and Zen (zen-browser.app) do the same thing.

Items marked **[builder call]** were decided by Claude during design, not by the owner. The owner can overturn any of them.

**Priorities** (owner, 2026-11-05). When goals pull against each other, this order decides:

1. The fastest Chromium browser.
2. The best computer use (browser agent) with most models, not only one provider's.
3. Looks good, professional and ready for production.
4. Fully working: every feature in this document ships working, not as a stub.

**Contents**

| | |
|---|---|
| 1–4 | Why, goals, non-goals, anti-goals |
| 5 | The browser shell: engine, DRM, layout, search, memory saver, Backrow, profiles |
| 6 | Look and feel |
| 7 | The agent: processes, page control, models, permissions, skills, chat, artifacts |
| 8 | Memory |
| 9 | CLI, MCP and outside agents |
| 10 | Import |
| 11 | Account, sync and encryption |
| 12 | Enterprise |
| 13–14 | Speed targets, benchmarks |
| 15–17 | Build order, constraints, left to the builder |

---

## 1. Why

The owner uses Aside daily. They want the same capability in a browser they control: their own look, their own tools built in, no subscription, and data that stays on their Mac or is end-to-end encrypted when it leaves.

## 2. Goals

1. **Real Chromium.** Chromium fork. Chrome Web Store extensions install and run unchanged.
2. **A strong browser agent.** It finishes multi-step tasks on live, logged-in sites. It is measured on the same three benchmarks Aside publishes (section 14).
3. **Bring your own model.** Codex and Grok subscriptions through `shared-ai-auth`. Claude through the user's installed Claude Code, or a Claude API key (section 7.3).
4. **Usable by other agents.** `perch` CLI, an MCP server, and one-command skill install for Claude Code, Codex and Grok. Grok Bot, which runs on xAI's cloud computer, can drive Perch on the owner's Mac through an encrypted relay.
5. **Memory like Aside's.** Agents pull durable facts out of chats and browsing into local markdown memory. A nightly pass consolidates it. Search runs on a local embedding model.
6. **Lightweight and fast.** A configurable memory saver built from Lulltab. No Google background services. Measurable targets in section 13.
7. **Private and secure by default.** Local first. Everything Perch stores is encrypted at rest. Sync is opt-in and end-to-end encrypted. True incognito. Detailed permission modes for agents.
8. **Easy to switch to.** Import from Aside, Chrome, Safari, Arc, Dia, Brave, Edge, Vivaldi, Opera, Firefox, Zen and Helium, including the tabs that were open.
9. **The owner's look, built with care.** UI follows `~/DESIGN.md` ("Blackletter" v2: near-black canvas, Geist / Geist Serif / Geist Mono, one blue accent `#4C8DFF`, light mode inverts) and the rules in section 6. Quiet, comfortable for all-day use, and nothing that reads as generated. Themes are selectable.
10. **Ready for companies.** Managed with the same tools IT already uses for Chrome: configuration profiles, Chrome policies, plus Perch policies for the agent, memory, sync and remote control (section 12).

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

### 5.2 Widevine (DRM)

Netflix, Hulu, Disney+, Prime Video, Peacock, Max and F1 TV need Google's Widevine CDM. Backrow's main use is exactly those sites.

- **Owner's decision: assume protected playback works, and build for it.** Perch is built with `enable_widevine=true`. On first run, Chromium's component updater downloads Google's Widevine module, as it does for other Chromium builds. Widevine is on by default and listed in the allowed connections (5.1).
- The unknown is VMP (Verified Media Path), a signature some services check before they allow full quality. Apexline gets one from castLabs EVS, but that only covers castLabs' Electron builds, not a Chromium fork. Without VMP a service may play normally, cap quality, or refuse.
- So the owner still applies to Google's Widevine programme in their own name for a VMP certificate (owner's decision). Google may turn down an individual; if so, revisit applying through a company. Approval upgrades quality; it is not a launch blocker.
- Step 2 of the build order includes a playback check: the owner logs in and tries each service above in a Perch build and records whether it plays and at what quality. Results go in `docs/drm-status.md`.
- If a service refuses to play, Perch shows a plain message naming the service and the reason, and 1.0 ships anyway (owner's decision). It never fails silently.
- No DRM workarounds of any kind: no key extraction, no licence tampering, no faked VMP.

### 5.3 Window layout

Taken from the owner's Aside screenshots.

- **Top bar**: horizontal tabs (Chromium's own tab strip, restyled), `+` button, and the profile button on the right edge with an avatar and a chevron.
- **Profile menu**: the profile list with a check on the current one and `⋯` for options, "New profile", then Bookmarks ›, Downloads ›, Extensions ›, History ›, Developers ›, Settings (⌘,), New Tab (⌘T), Incognito Window (⇧⌘N).
- **Hide chrome**: one shortcut and a setting hide the tab strip and bookmarks bar completely. The address bar appears on ⌘L and a tab switcher on ⌃Tab. Top-edge hover can reveal the bar, as a setting.
- **Split view**: two tabs side by side in one window, with a draggable divider. Built on Chromium's split-view feature where it exists, extended to work from the tab context menu and a shortcut.
- **Right sidebar**: the agent chat (section 7.6). Toggled with a toolbar button and a shortcut. Resizable; the width is remembered per window.
- **Side chats belong to a tab** (owner, 2026-11-05). A side chat opened in a tab stays with that tab. Switching to another tab hides it; that tab shows its own side chat if it has one, or none. Switching back shows it again with its scroll position and unsent draft. A task keeps running while its tab is in the background, and the tab shows the perch dot. Moving a tab to another window takes its side chat along.
- **Themes**: five themes (Ink, the default; Graphite, a neutral grey; Dusk; Paper, light; Contrast) and five accents (Blue, the default; Teal; Amber; Rose; Mono). A theme changes every surface, text and accent colour in the chrome and in Perch's pages at once, through one token file. Values are in the repo's `DESIGN.md`; visual rules are in section 6.

### 5.4 UI technology

- Native chrome (tab strip, toolbar, profile button, split view) stays C++ Views and is restyled through patches and theme colours. Moving it to web tech would cost speed. **[builder call]**
- Everything Perch adds (sidebar chat, full-page chat, artifacts pane, settings pages, memory and skills managers, import wizard, new tab page) is WebUI: TypeScript + a light framework (Preact or Lit), loaded lazily so a window without the sidebar costs nothing. **[builder call]**

### 5.5 Address bar and search

- Default search: Brave Search.
- Pressing **Tab** in the address bar while typing a query switches that query to Google; a chip shows "Google", and Tab again or Backspace switches back. This replaces Chromium's tab-to-search keyword behaviour for those two engines. Other keyword engines keep working.
- The address bar can also start an agent chat ("Ask"), like Aside's Search / Ask toggle, with ⌘Enter. **[builder call]**
- **New tab page**: the Perch mark, a large "Search or ask" box, recent chats and routines, and three suggested tasks: Set up your memory, Find routines to automate, Import from another browser. Layout in `DESIGN.md`.

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

### 5.9 What Chrome is missing, built in

Owner's request: the features people most often add to Chrome with extensions or wish it had, on by default. Each has an off switch in Settings, and none sends data anywhere. **[builder call]** on the list itself.

- **Ad and tracker blocking**: a built-in content blocker using EasyList and EasyPrivacy rules (the `adblock-rust` engine Brave uses), so it keeps working under Manifest V3. Filter list updates join the allowed connections in 5.1. One click turns it off for a site.
- **Cookie banners rejected automatically** where the site offers a reject option, using the same filter engine.
- **Tracking parameters removed** (`utm_*`, `fbclid`, `gclid`, `mc_eid` and similar) from links you open and URLs you copy.
- **HTTPS-only** and **encrypted DNS** (DNS over HTTPS, falling back to the system resolver) on by default.
- **Fingerprinting protection**: Chromium's privacy budget features plus a reduced user-agent and no third-party cookies.
- **Command bar** (⌘K): tabs, history, bookmarks, chats, commands and settings in one search.
- **Copy URL** (⇧⌘C) and **copy as Markdown link** (⌥⇧⌘C), as in Arc.
- **Tab tools**: close duplicates, close tabs older than a chosen age, mute a tab by clicking its speaker, and tab search.
- **Spaces**: named sets of tabs per profile, like Arc spaces, built on saved tab groups.
- **Reader view** from Chromium's distiller, set in Geist and Geist Serif, with the theme's colours.
- **Picture in picture** on every video, starting automatically when you switch away from a playing video. **Playback speed** keys (`[` and `]`) and a speed menu on every video.
- **Link preview**: ⇧-click opens a link in a floating card you can expand into a tab.
- **Full-page screenshot** with simple markup, from the menu and ⇧⌘2.
- **On-device translation** using Chromium's local translation models, never Google's servers.
- **Per-site panel** in the address bar: permissions, the blocker switch, dark mode for this site, and "Forget this site", which clears its cookies and data.
- **Built-in authenticator**: the password manager stores passkeys and generates one-time codes for sites that use TOTP, so codes fill without a phone (spec 7.2 rules apply: the model never sees them).

## 6. Look and feel

Perch follows `~/DESIGN.md` and the unslop rules (unslop by Damir Sokolovsky, @heydamir, CC BY 4.0). People look at a browser for hours, and the pages they visit should carry the colour. So the chrome stays quiet, and the richness goes into one or two moments that belong to Perch alone.

### 6.1 Direction

- **Product**: a Mac browser where an agent works on your logged-in sites for you, and nothing leaves the Mac unencrypted.
- **Character**: quiet, exact, watchful.
- **World**: a reading desk at night. Ink, paper, the margin where notes go, a window looking out.
- **Moments**: (1) the agent at work: in the sidebar, the live step line ("Opened gmail.com", "Typing reply") above a small live thumbnail of the agent's tab; (2) the artifacts pane, where the artifact itself carries colour. Nothing else in the chrome gets rich colour.
- **Signature**: the perch dot, a 6 px accent dot. It sits on any tab the agent is using, in the sidebar header while a task runs, and on the profile button when a task is waiting for approval. It appears nowhere else.

### 6.2 Colour

- Surfaces, borders and text come from DESIGN.md's neutral ramp: canvas `#000000`, card `#0A0A0C`, elevated `#111114`, hairlines at 6% and 14% white.
- The tab strip and toolbar are canvas. The active tab is one surface step up with a hairline edge, not a colour.
- Three text roles: ink, body (86%) and mute.
- The accent (`#4C8DFF`, `#2F6FE0` in light themes) is used only for: the perch dot, focus rings, the selected row in a list, text selection, the search-engine chip in the address bar, and links in chat.
- Primary buttons are off-white with black text (DESIGN.md `button-primary`), one per view.
- Semantic colours carry meaning only. An approval card for a payment or deletion shows the amount or the item plainly; the confirm button's label names the action, and only its text turns `danger`.
- None of these: hue-to-hue gradients, glows, coloured shadows, glass blur panels, colour washes behind content. Depth comes from surface steps and hairlines. Menus and popovers may have one soft neutral shadow.
- Themes change only the ramp and the accent shade. Layout, type and spacing stay the same.

### 6.3 Type

- Interface: Geist. 13 px for browser chrome (tabs, menus, settings rows), 14 px for chat text, 12 px for captions. Weights 400 and 500 only.
- Geist Mono for meta: domains, counts, timestamps, RAM figures, keyboard shortcuts, model ids, the audit log. Tabular figures wherever numbers line up.
- Geist Serif appears only in large titles on empty states and the welcome screen, never in the chrome.
- Sentence case everywhere. No uppercase tracked section labels, no italic for emphasis, no negative tracking on small text.

### 6.4 Spacing and shape

- Everything sits on a 4 px grid.
- Heights: tab strip 36 px, toolbar 40, sidebar header 44, list rows 32, menu rows 28.
- Padding: sidebar 16, cards 20, settings page edges 32.
- Radii from DESIGN.md: controls and tabs 8 (tabs on their top corners only), cards, popovers and the sidebar panel 12, elements inside a 12 px panel 8. Only status dots are round.
- Density setting: Comfortable (default) and Compact (rows 28, tab strip 32). Perch's own pages follow browser zoom and macOS text size.

### 6.5 Icons

- One set: Lucide, 16 px, 1.5 stroke, coloured by their text role. Icons sit in a fixed 16 px column with an 8 px gap to the label.
- No emoji in the interface. No sparkle icon for AI. The agent is shown with the Perch mark, a flat single-colour glyph.
- Site favicons are the only full-colour icons in the chrome.

### 6.6 Copy

- Short, plain, sentence case. No exclamation marks. No trailing periods on labels, buttons or titles.
- Composer placeholder: "Ask Perch a task, @ for context".
- Buttons name the action: "Send message", "Pay $42.18", "Delete 3 emails". Never "OK" or "Confirm" on an approval.
- Errors say what happened and what to do next, for example "Netflix won't play in this build. Google hasn't approved Perch's video signature yet".
- No "AI-powered", "magic", "supercharge", "seamless". No PRO, New or Beta badges.
- All strings follow `~/ANTI AI WRITING.md`.

### 6.7 Motion

- One easing curve, `cubic-bezier(0.2, 0, 0, 1)`. 120 ms for hover and press, 180 ms for menus and popovers, 240 ms for the sidebar opening.
- Only colour, opacity and transform animate. Never width, height or position properties.
- One looping animation in the whole browser: the perch dot fades slowly while a task is really running, and stops the moment it ends.
- With "Reduce motion" on in macOS, state changes are instant.

### 6.8 Comfortable and native

- It behaves like a Mac app: traffic lights, a full menu bar with every command, shortcuts that match Safari and Chrome, full keyboard access, VoiceOver labels on every control, and the system's text size and Increase Contrast settings respected.
- All text meets WCAG AA contrast in every theme, and keyboard focus is always visible.
- Settings is one searchable page with grouped sections. Every Perch setting has a one-line explanation under it. Managed settings show who manages them (section 12).

### 6.9 Design review

- Every step in the build order that adds UI ends with an unslop pass: the signs list and the checklist, on off-screen renders. Perch's pages render headless, and the native chrome renders through an off-screen self-test like agterm's. Never capture the screen or drive the GUI while the owner is using the Mac.
- A screen passes when the checklist is clean and the template check holds: with Perch's name removed, the screen would not fit another browser.

## 7. The agent

### 7.1 Processes

- **`perchd`**: a local daemon started by the browser, written in TypeScript and compiled to one binary with Bun. **[builder call]** It runs the agent loop, model connections, memory, skills, the MCP server, the CLI endpoint and the relay client. It shuts down with the browser unless remote control is on.
- `perchd` controls the browser through the Chrome DevTools Protocol over a private pipe (`--remote-debugging-pipe`), never a TCP port. Browser-only features (credential fill, approval prompts, tab ownership) go through a small set of custom CDP domains added by our patches. **[builder call]**
- The CLI and the MCP server reach `perchd` through a Unix socket in the user's Application Support folder, mode 0600, with a per-client token.

### 7.2 How the agent sees and acts on pages

- **Page snapshot**: a compact text view built from the accessibility tree plus visible text. Interactive elements get short refs (`e12`). Key content comes first, and the output is kept small (Aside reports theirs as 70% smaller than agent-browser's). This is the main input.
- **Actions**: navigate, click(ref), type(ref, text), select, scroll, hover, press key, upload file, wait for, go back, open/close/switch tabs, read PDF, download.
- **Fallback**: screenshots with coordinate clicks (computer use) when the snapshot cannot express the page (canvas apps, maps).
- **REPL**: a Playwright-style JavaScript tool for bulk extraction and scripted steps, as in `aside repl`.
- **Agent tabs**: the agent works in background tabs grouped under an "Agent" tab group, so it never steals focus from the tab the user is on. The user can watch any agent tab live.
- **Logins**: when a site needs a login, the agent asks the browser to fill credentials from Perch's password manager. The browser fills the fields directly. The model sees only "filled" or "no saved login". The same applies to one-time codes and payment cards.
- **What "never sees a secret" covers** **[builder call]**: values Perch fills from its own stores (passwords, cards, saved one-time codes, passkeys). After a fill, those fields are redacted in snapshots, masked in screenshots, and blocked from REPL reads (the REPL cannot read `value` of password, card or OTP-autocomplete fields). Codes the user asks the agent to fetch from their own email or Messages are not covered: reading the user's mail on request is a normal task, and the approval rules in 7.4 still apply.
- **Bot challenges**: Perch is a real browser with a real profile, so most sites treat it as a person. When a CAPTCHA appears, the agent pauses and asks the user.

### 7.3 Models and sign-in

| Provider | How | Notes |
|---|---|---|
| ChatGPT / Codex subscription | OAuth through `@neelsatyavolu/shared-ai-auth` (Codex flow) | Model list from the package's `models.json`. |
| Grok subscription | OAuth through `shared-ai-auth` (Grok flow) | |
| Claude subscription | Perch runs the user's installed Claude Code CLI headless (`claude -p --output-format stream-json`) with Perch's browser tools attached over MCP | Claude Code owns the login and the agent loop. Perch never reads or copies Claude Code's tokens. |
| Claude API key | Perch's own agent loop against the Anthropic API | For users without Claude Code. |

The Claude choice is deliberate. Aside copies Claude Code's OAuth tokens into its own agent. Anthropic's terms do not allow third-party apps to use a Claude.ai subscription login that way, and a public MIT repo would make it obvious. With Claude Code as the runner, Claude users get the subscription without breaking the terms. The cost is that the Claude path uses Claude Code's agent loop and system prompt, so it will be heavier than Perch's own loop; the benchmark runs will show by how much. **[builder call, confirmed in principle by the owner: "make it possible"]**

Tokens are stored in the macOS Keychain, scoped to Perch's code signature. The model picker shows provider, model, effort (off → max) and a fast toggle, as in the screenshot.

**More providers** (owner priority 2, most models): besides the subscriptions above, Settings → Models → Connect adds API keys for Anthropic, OpenAI, xAI, Google Gemini and OpenRouter, and any OpenAI-compatible endpoint such as Ollama or LM Studio running on the Mac.

**Task models** (owner, 2026-11-05, modelled on Aside's Models page). Perch uses different models for different kinds of work. Each role has a picker and a `⋯` menu for effort and fast mode:

| Role | Used for | Default when signed in **[builder call]** |
|---|---|---|
| Default model | New chats. The last model used becomes the default | the strongest signed-in model |
| Fast | Side work, summaries, memory extraction and dreaming | the provider's fast tier (for example GPT-6 Luna) |
| Standard | Subagents and memory reorganisation | the provider's mid tier (for example GPT-6.1 Sol) |
| Deep | Hard reasoning, planning, judging and synthesis | the provider's flagship (for example Opus 5.5 or GPT-6 Astra) |
| Visual | Screenshots and reading page images | a model with image input |
| Image generation | Making and editing images in chat and artifacts | ChatGPT Images or Grok Imagine, if signed in |

Perch does not solve CAPTCHAs; the agent stops and asks the user (7.2).

### 7.4 Permission modes

Per chat, with a profile default. Shown at the bottom left of the composer.

- **Ask**: every action that changes something waits for approval. Reading and navigating do not.
- **Guard** (default): reading, navigating, searching and filling forms run freely. Approval is needed to submit anything that sends, posts, buys, books, deletes, changes account settings or shares, plus file access outside the chat's folder, downloads that run, and credential fill on a site for the first time.
- **Skip confirmation**: runs without asking. Payments, purchases and password changes still wait for approval.

On top of the mode:

- per-site rules: always allow, always ask, never touch (for example, never act on a bank site)
- per-client rules for outside agents: the CLI, each MCP client and the relay get their own mode, Guard by default
- an audit log of every agent action: time, tab, site, action, which client, and whether it was approved; viewable and exportable in Settings
- approval cards show exactly what will be sent (the message text, the order total) before the user approves

### 7.5 Skills

- The skill format is the same `SKILL.md` format Claude Code uses (frontmatter name + description, markdown body, optional scripts), so skills move between Perch, Claude Code and Codex.
- **Built-in site skills** (read on demand, like Aside's): Google Account, Gmail, Google Docs, Sheets, Slides, Drive, Calendar, Search; Outlook and Microsoft 365; Slack; Discord; Notion; GitHub; Linear; Jira; Figma; X; Reddit; LinkedIn; YouTube; Instagram; WhatsApp Web; Amazon; Airbnb; Google Maps; Canvas LMS; Messages (iMessage, read and send through the local Messages database and AppleScript, with Full Disk Access the user grants); plus file skills: PDF, DOCX, XLSX, PPTX.
- Where a site has a stable web API reachable with the user's logged-in session, the skill uses it so tasks run without opening a tab (Aside's Gmail and Docs skills work this way).
- **My skills**: import from a folder, a URL or a git repo. Shown in a Skills / MCPs settings page like Aside's.
- **MCP client**: users can add MCP servers (stdio, Streamable HTTP and SSE) that the Perch agent can call, in Settings → Skills and MCP. Tool annotations are honoured: tools marked read-only run freely; every other MCP tool counts as risky under 7.4 unless the user marks the server as trusted. Each server can be switched off per chat.
- **Import MCP servers** (owner, 2026-11-05): one click imports the servers already set up in Claude Code (`~/.claude.json` and project `.mcp.json`), Codex (`~/.codex/config.toml`, `[mcp_servers.*]`), Claude Desktop, Cursor and Grok. Perch lists what it found and the user picks. Secrets in a server's `env` or headers move into the Keychain and never stay in plain files. Imported stdio servers run as the user with Perch's environment, and their first run asks for approval.

### 7.6 Chat UI

**Sidebar** (screenshot 1; one per tab, see 5.3): header with chat title and a menu of recent chats, new-chat and close buttons. Empty state shows the Perch mark. The composer shows a chip for the current tab (favicon, title, domain); `@` adds other tabs, files, memory or skills as context; `+` attaches files; a microphone button dictates with macOS on-device speech recognition. Under the composer: permission mode, which tabs the agent may use (current tab / all tabs / new agent tabs), and the model + effort picker.

**Full-page chat** (screenshot 7): opened from the chat menu or a `perch://chat` tab. Left: chat list (toggleable). Centre: the conversation. Right: the artifacts pane. Header: title (editable), `⋯`, Share (exports to a file; there is no hosted share), and pane toggles.

**Message rendering**: a streaming markdown parser that handles partial input without flicker; headings, lists, tables, links, code with syntax highlighting, math, and inline citations to the tabs and pages the agent used. Tool steps ("Opened gmail.com", "Clicked Send") collapse into one expandable line per turn. Each reply has copy, branch and timestamp, as in the screenshot.

### 7.7 Artifacts

- The agent can make artifacts: HTML pages, React components, SVG, Mermaid diagrams, markdown documents, and data files (CSV, JSON).
- In the full-page chat they open in the right pane; in the sidebar they open in a new tab. Versions are kept per artifact.
- They render in a sandboxed origin (`perch-artifact://<id>`) with no access to cookies, the profile or other tabs, and no network except an allowlist of CDNs. The user can save one to disk or open it as a tab.

## 8. Memory

Modelled on how Aside stores memory on this Mac (`~/.aside/u/0/memory/`):

- **Storage**: markdown files per profile. Top-level `MEMORY.md` (agent operating rules) and `USER.md` (stable facts about the user), both kept small enough to load into every chat. Topic pages under `users/`, `people/`, `companies/`, `sites/`, `projects/`, `routines/`, `concepts/`, each with frontmatter plus "Current" and "History" sections. `episodic/` holds append-only dated entries. A `TAXONOMY.md` holds the filing rules.
- **Extraction**: after each chat, a small model call extracts durable facts and files each one in exactly one place. Browsing history extraction (which sites the user uses for what) is opt-in and runs locally on a schedule.
- **Dreaming**: a nightly consolidation pass merges duplicates, updates "Current", moves stale facts to "History" and writes a dated log the user can read.
- **Search**: SQLite FTS5 plus vectors from a small local embedding model run with onnxruntime; no text leaves the Mac for indexing.
- **Control**: a Memory page to browse, edit and delete anything, pause extraction, or wipe memory. Incognito never reads or writes memory.
- **Which model extracts**: the profile's "fast" model on whatever provider is signed in. The user can turn extraction off entirely.
- **Set up your memory**: a guided first task, like Aside's. Aside's version is a single prompt: research everything about the user (browsing history, built-in skills such as mail, memories saved in other AI services, web search), file it into memory, then score whether it is enough to write messages in the user's tone, buy on unfamiliar sites and review documents, and keep filling gaps until the score passes 9 of 10. Perch does the same job with the user in control: a sheet lists each source (browsing history, mail, calendar, Messages, ChatGPT/Claude/Grok memory exports, an Aside import, a web search on the user's name), each with its own switch and web search off by default. The agent then builds the profile and shows a review page grouped as About you, People, Places and accounts, Writing style and Sites, where every fact can be edited or removed before "Save to memory". Nothing is saved until then.
- **Routines**: saved tasks that run on a schedule or a trigger (for example "every weekday at 8, summarise new mail from my teachers"). "Find routines to automate" looks for tasks the user did at least twice in the last 30 days and proposes routines; the user approves each one. Routines run under the profile's permission mode and appear in the audit log.

## 9. CLI, MCP and outside agents

### 9.1 `perch` CLI

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

### 9.2 MCP server

Tools: `exec` (hand a whole task to Perch's agent), `repl`, `tabs`, `snapshot`, `act` (click/type/etc. by ref), `screenshot`, `memory_search`, `browser_profiles`. These are the same tools Aside exposes (`mcp__aside__exec`, `repl`, `memory_search`, `browser_profiles`) so existing prompts carry over. Every call goes through the permission system as that client.

### 9.3 Grok Bot and remote control

Grok Bot runs on xAI's cloud computer, not the owner's Mac. Aside handles this with "Remote Control": the bot installs the Aside CLI, logs in with an 8-character code the user approves in Settings, then runs `aside exec --host <device>` through Aside's relay. Perch does the same:

- **Settings → Developers → Remote Control**, off by default.
- A relay on Cloudflare (Worker + Durable Object per device, WebSocket). The remote CLI and the Mac exchange keys at pairing, and every message is end-to-end encrypted between them, so the relay only passes ciphertext.
- `perch login --email` shows a code; the user approves it in Perch, which names the device and the permission mode it gets (Guard by default).
- Settings shows a ready-to-paste connection prompt for Grok Bot (and other cloud assistants), like Aside's.
- A remote MCP endpoint over the same relay, for assistants that take an MCP connector URL. The URL carries a revocable token.
- Every remote device is listed with last use, and can be revoked.

### 9.4 agterm and the owner's other apps

The owner was unsure what agterm could add. **[builder call]**:

- agterm already injects MCP servers (consult, memory) into the `claude`/`codex` it launches. Add Perch's MCP server to that list when Perch is installed, so every agent tab in agterm can use the browser.
- Links clicked in agterm open in Perch when Perch is the default browser (no special work).
- `perch skill install` covers Claude Code, Codex and Grok outside agterm.
- Lulltab and Backrow are built in (sections 5.6, 5.7).

## 10. Import

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

## 11. Account, sync and encryption

### 11.1 At rest on the Mac

Security is a top priority (owner, 2026-11-05: "very high, highly encrypted"). The rules below are requirements, not goals, and each release's security review checks them.

- Chromium's own stores (cookies, passwords, cards) use Chromium's encryption with a "Perch Safe Storage" Keychain key, as Chrome does.
- Perch's own data (memory, chats, skills, artifacts, audit log, model tokens) is encrypted with AES-256-GCM using a per-profile key. That key is wrapped by a Secure Enclave key, so it cannot be copied off the Mac. **[builder call]**
- Memory and skills are still markdown, just encrypted on disk. People and agents read and edit them through Perch: the Memory and Skills pages, `perch memory` / `perch skills`, and the MCP server (which is how the Claude Code path reads them). `perch skills export <dir>` writes plain `SKILL.md` folders for use in Claude Code or Codex, and `perch skills install` reads them back. **[builder call]**
- Moving to a new Mac: a Secure Enclave key does not survive Migration Assistant or a Time Machine restore. At setup Perch creates a recovery key (the same one sync uses) and offers an encrypted export file. With sync on, a new Mac just pairs. Without sync, the export file plus the recovery key restores everything. Perch tells the user this at setup. **[builder call]**
- Optional Touch ID lock for passwords, memory and chats, as a setting.
- Every secret Perch holds (model tokens, API keys, MCP server secrets, the sync key, the relay keys) lives in the Keychain or behind the Secure Enclave key, never in a plain file, a log, an environment dump or a crash report.
- `perchd` and imported MCP servers run with the least access they need: the daemon's socket is 0600, outside agents connect with per-client tokens, and the browser process keeps Chromium's sandbox for renderers.
- Memory, chats and the audit log are encrypted per record, so a partial copy of the profile folder reveals nothing.
- Release builds use the hardened runtime, are notarized, and are checked for dependencies with known vulnerabilities before each release.

### 11.2 Account

- Optional. Perch works fully without one.
- Sign-in with email and a passkey; email codes sent through Resend as a fallback, as the owner's other n3el/xanom apps do. **[builder call]**
- The account exists only to hold encrypted sync data and the list of paired devices.

### 11.3 Sync (opt-in, end-to-end encrypted)

- Browser data (bookmarks, history, passwords, open tabs, settings, extensions list) uses Chromium's built-in sync engine pointed at Perch's own server, with Chromium's client-side passphrase encryption always on. This is the model Brave Sync uses with its open-source server (`brave/go-sync`). Perch's server implements the same protocol on Cloudflare Workers + D1 + R2. **[builder call]**
- Perch's own data (memory, skills, chats, artifacts) syncs as encrypted blobs through the same account.
- Keys: the sync key is created on the first device. A new device joins by scanning a code on a device that already has the key, or by entering a recovery key the user saved at setup. Perch has no way to recover data without one of those, and says so at setup.
- The server stores ciphertext, sizes, timestamps and device ids. It cannot read anything.
- Each data type can be switched on or off separately.

### 11.4 Who the server is for

Owner's decision: **everyone, free, with limits.** Anyone who downloads Perch can use the hosted sync and relay. Each account gets a storage cap and rate limits sized so the service stays within Cloudflare's free and low-cost tiers (exact numbers are the builder's call, set from measured usage). Accounts that hit the cap are told, not cut off silently. A one-command self-host deploy of the same Worker is documented for people who want their own server. The server needs abuse limits on sign-up, pairing and relay traffic from the start.

### 11.5 Telemetry

None by default. An opt-in anonymous daily ping to `analytics.n3el.dev` (random install id, Perch and Chromium version, CPU type), the same contract as Lulltab. **[builder call]**

## 12. Enterprise

Perch is managed the way companies already manage Chrome, so an IT team can deploy it without learning a new system.

### 12.1 Deployment

- A signed and notarized `.pkg` for MDM tools (Jamf, Kandji, Intune, Mosyle) as well as the `.dmg` for people.
- Policies arrive as macOS configuration profiles (managed preferences for `co.xanom.perch`), the same mechanism Chrome uses.
- Update control by policy: turn automatic updates off, pick the stable or beta channel, delay updates by a number of days, or pin a minimum version.

### 12.2 Policies

- **Chrome policies**: the standard Chromium enterprise policies work unchanged, including extension allow and block lists, forced extensions, homepage and startup pages, download restrictions, proxy and certificate settings, URL blocking and incognito availability. Policies that only make sense for Google services (Google sync, Google sign-in) are ignored and listed as such.
- **Perch policies**:

| Policy | What it controls |
|---|---|
| `AgentEnabled` | Turns the agent on or off |
| `AllowedModelProviders`, `AllowedModels` | Which providers and models users can pick |
| `ModelEndpoints` | Company-run endpoints (OpenAI-compatible or Anthropic-compatible URL plus key reference) that replace personal sign-in |
| `MaxPermissionMode` | The highest mode users can choose (for example, Guard) |
| `AgentSiteRules` | Sites the agent may never act on, or must always ask on |
| `MemoryEnabled`, `HistoryExtractionEnabled` | Memory on or off; whether browsing history may feed it |
| `MCPServerEnabled`, `AllowedMCPClients` | Whether outside agents can connect, and which |
| `RemoteControlEnabled` | Whether the relay (Grok Bot and other cloud assistants) can be used |
| `SyncEnabled`, `SyncServerURL` | Sync on or off, or pointed at the company's own server |
| `ImportEnabled` | Which browsers and data types users can import |
| `BuiltInExtensions` | Turn Backrow or the memory saver off |
| `TelemetryEnabled` | Forced off (it is already off by default) |
| `AuditLogPath` | Writes the agent audit log as JSON lines to a path the company's security tools collect |

- `perch://policy` lists every active policy and where it came from. Settings rows that a policy controls show "Managed by your organization" and are locked.

### 12.3 Company sync server

- The self-host deploy from 11.4 doubles as the company server. It adds sign-in through the company's identity provider (OpenID Connect), and admins can list and revoke devices.
- Data stays end-to-end encrypted. The company server holds ciphertext only, the same as Perch's hosted one. **[builder call]**

### 12.4 Security practice

- `SECURITY.md` with a private reporting address and response times.
- Chromium security fixes ship within 72 hours of Google's stable release. **[builder call]**
- Each release publishes its Chromium version, the patch list, a software bill of materials, and checksums. Release builds are signed and notarized, and Sparkle updates are EdDSA-signed.
- The macOS system trust store and company root certificates work without extra setup.

## 13. Speed and weight targets

Measured on the owner's Mac against Chrome of the same Chromium version, with the same extensions:

- Speedometer 3 and JetStream within 2% of Chrome.
- Cold start to a usable window no slower than Chrome.
- Idle memory of Perch's additions (sidebar closed, `perchd` idle) under 60 MB.
- With the window idle and sync off, a packet capture shows no requests outside the allowed list in 5.1, and none at all with every item on that list switched off.
- With 100 tabs open and the memory saver at default, total memory at least 50% lower than Chrome without a saver.

## 14. Benchmarks

Run the three suites Aside publishes (`github.com/at-inc/aside-benchmarks`):

- **Online-Mind2Web**: 300 tasks across 136 live sites.
- **BU Bench V1**: 100 hard tasks drawn from WebBench, Mind2Web 2, GAIA, BrowseComp and interaction tests.
- **Odysseys**: 200 long, multi-site tasks, scored by rubric.

A `bench/` folder holds the runner, which drives Perch through the CLI with a chosen model and records full transcripts. Grading follows each suite's published method. Results are published in the repo in the same format as Aside's, including failures and "impossible" tasks. The target is to match Aside's harness with the same model (Aside reports 99.0% on Online-Mind2Web with GPT-5.5). Treat that as a target, not a promise. Live sites change, so each run records its date.

## 15. Build order

One design, built in this order. Each step ends with something the owner can use, and every step that adds UI ends with the design review in 6.9.

1. **Fork pipeline**: checkout, patch series, branding, signed and notarized build, Sparkle updates, Widevine enabled. The owner applies for a VMP certificate now.
2. **Shell**: theme, restyled tabs and profile menu, hide-chrome mode, split view, Brave + Tab-for-Google, privacy patches, true incognito, built-in memory saver and Backrow, DRM playback check (5.2).
3. **Agent**: `perchd`, page snapshot and actions, sidebar chat, Codex/Grok/Claude sign-in, permission modes and audit log, credential fill, full-page chat and artifacts.
4. **Outside agents**: CLI, MCP server, skill installers, agterm hook-up, built-in site skills.
5. **Memory**: storage, extraction, dreaming, local search, Memory page.
6. **Import**: all browsers, open-tab restore, Aside extras.
7. **Account, sync and relay**: server on Cloudflare, E2E sync, remote control, Grok Bot.
8. **Enterprise**: `.pkg`, Chrome policy support check, Perch policies, `perch://policy`, audit log export, company sync server with OpenID Connect, release SBOM.
9. **Benchmarks and speed**: the three suites, the targets in section 13, public results, then a 1.0 release and the site at `perchbrowser.com`.

## 16. Constraints

- Chromium is BSD-licensed; Perch's own code is MIT. Patches borrowed from other forks keep their licences and credits.
- Anthropic's terms rule out reusing Claude Code's tokens; see 7.3.
- `shared-ai-auth` supports Codex and Grok only. It must be used as-is or extended in its own repo.
- Full-quality protected playback may need a VMP certificate from Google; see 5.2.
- macOS only, Apple silicon only.
- One developer plus agents. The Chromium rebase every four weeks is ongoing work, not a one-time cost.
- Owner rules that apply: don't drive the GUI with osascript or screen capture while the owner is using the Mac (agterm lesson); verify with tests, logs and off-screen checks; never print or store secrets.

## 17. Left to the builder

- Exact patch boundaries and which Chromium features to reuse versus write.
- The WebUI framework choice within "light and lazy".
- The snapshot format details and the agent's prompts, judged by benchmark results.
- The embedding model, as long as it runs locally and is small.
- The wording of every UI string, following `~/ANTI AI WRITING.md`.
- The list of built-in skills beyond those named, by popularity.
