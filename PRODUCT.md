# Product

<!-- impeccable:product-schema 1 -->

## Platform

web (the marketing site at perchbrowser.com; the product itself is a native macOS app, Chromium-based)

## Users
People on a Mac who live in their browser and already pay for an AI subscription (ChatGPT, Claude or Grok), and want an agent that can work in the sites they are signed in to without handing their browsing to a new company. Often developers and heavy tab users who know Chrome, Arc or Aside and care about speed and privacy.

## Product Purpose
Perch is a fast, private, open-source browser for macOS, built on Chromium so every Chrome extension works. An agent in the sidebar uses the sites you are logged into, with your own model subscription, and asks before anything is sent, posted, bought or deleted. Success for the site: a visitor understands that in seconds and downloads the beta.

## Positioning
Chromium-native (tabs, toolbar and menus are Chromium's own code, not a web-page shell) plus an agent that runs on the user's own ChatGPT, Claude or Grok account, with no Perch account, no paid plan and no model of its own. MIT licensed end to end, including the sync server, which a user can self-host and which only ever stores ciphertext.

## Operating Context
A Mac on Apple silicon, macOS 13 or later. The beta is distributed as a signed, notarized DMG (Perch-0.1.2.dmg, 197 MB) on a GitHub pre-release (v0.1.2-beta) of the public repo neelsatyavolu/perch. The site is static HTML served by a Cloudflare Worker (site/), deployed with `bunx wrangler deploy`.

## Capabilities and Constraints
Built and working in the beta (confirmed in the repo): side chat per tab with an agent that reads and acts on pages; approval cards; permission modes (Ask, Guard default, Skip confirmation) and site rules; audit log; models via ChatGPT/Codex sign-in, Claude Code, Grok, API keys and local OpenAI-compatible servers; built-in ad and tracker blocker; sleeping tabs (memory saver); Spaces; split view; command bar; import from other browsers and Aside; `perch` CLI and MCP server; optional end-to-end encrypted sync; five themes and five accents; frosted Perch menus.
Not yet true and must not be claimed: measured speed results (the 1.0 speed numbers are targets, stated as targets); a Windows or Intel build; a .pkg installer (needs the Installer certificate); dictation (deferred until after the first release).

## Brand Commitments
Name: Perch. Mark: a horizontal bar with a dot perched above its right end. Voice: plain, specific, no hype, no exclamation marks, sentence case. Visual system: perch/DESIGN.md (Blackletter-derived; Geist, Geist Mono, Geist Serif; Ink and Paper themes; one blue accent).

## Evidence on Hand
Real app builds (out/Release, out/Dev) that can be screenshotted, including the headless snapshot tool (`perch-build snapshot`) and sample-data perchd fakes for agent states. No testimonials, customers, press, user counts or benchmark results exist; none may be invented.

## Product Principles
- Speed first: add as little as possible on top of Chromium.
- The agent asks before it acts, and shows exactly what will go out.
- Your data stays on your Mac unless you choose to sync, and sync is end-to-end encrypted.
- Bring your own model; no Perch account or plan.
- Everything is open source.
