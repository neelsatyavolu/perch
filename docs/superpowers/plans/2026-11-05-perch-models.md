# Perch plan: models and providers (`perchd`)

**Goal:** Everything behind Settings → Models (spec 7.3), as a tested TypeScript API in `perchd` that the settings page (plan 3b) calls: providers to connect, the six task model roles, model capability data, a connection test per provider, and image generation into the chat's folder. Secrets live in the macOS Keychain; Perch's own settings are encrypted at rest.

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md` 7.3 (models and sign-in), 11.1 (at rest on the Mac). Builds on plan 3a's adapters in `perchd/src/models/`.

## Aside parity checklist

Aside's Models page (docs.aside.com/help/ai, read 2026-11-05) has Providers (Subscription, API, Local) and Task models. Perch has no hosted plan, so the "Aside" provider type has no equivalent.

| Aside | Perch | Where |
|---|---|---|
| Subscription: ChatGPT (Codex) | Sign in with ChatGPT through `shared-ai-auth`, loopback callback on 1455 or pasted URL, as Flint does | `models/oauth.ts` |
| Subscription: Claude | Claude Code headless as the runner (Perch never touches its tokens) | `models/providers.ts` (detects the CLI), `external.ts` (unchanged) |
| Subscription: GitHub Copilot, Kimi | Not offered: no sign-in flow that the terms allow for a third-party app | deferred |
| Grok subscription (Aside has none) | Sign in with Grok through `shared-ai-auth`, pasted code | `models/oauth.ts` |
| API: Anthropic, OpenAI, Google, xAI, OpenRouter | API keys in the Keychain, checked before they are saved | `models/registry.ts` |
| API: Vercel / Cloudflare AI Gateway, Command Code | Covered by "OpenAI-compatible endpoint" with a base URL and optional key | `custom` provider |
| Local: Ollama, LM Studio | OpenAI-compatible endpoints on localhost, reachability test, live model list | `models/chat-completions.ts` |
| Task models: Default, Fast, Standard, Deep, Visual, Image generation | Same six roles, effort and fast toggle per role; the last model used becomes Default | `models/roles.ts` |
| Visual choices limited to vision models | Same, enforced in `setRole` and in fallbacks | `models/roles.ts` |
| Retired model falls back to the first reachable one | Every role resolves to a reachable model; the result says when it fell back and why | `models/roles.ts` |
| Model list from a catalog API, no app update | Codex/Grok from `shared-ai-auth`'s `models.json`; API providers from their own `/models` endpoints; capability table for known ids | `models/catalog.ts` |
| Expired OAuth shows Reconnect | Provider status `expired` when a refresh fails | `models/oauth.ts` |
| Image generation in chat (ChatGPT when connected) | OpenAI Images, Grok Imagine, Gemini (Nano Banana), ChatGPT sign-in via the Responses image tool; files saved in the chat folder | `models/images.ts` |

Perch goes further than Aside on: every key checked before it is saved, a connection test for every provider (including local), and settings encrypted with a Keychain key rather than kept as plain JSON.

## Decisions

- **Keychain:** `Bun.secrets` (Keychain Services on macOS), service `com.perch.perchd`. Nothing passes a secret on a command line. Tests use an in-memory keychain.
- **Settings at rest:** one file, `models.settings`, AES-256-GCM with a random 256-bit key kept in the Keychain; magic + version header, 12-byte IV, tag, the file name as associated data; written atomically with mode 0600. An unreadable file is moved aside and Perch starts with defaults (the file holds choices, never secrets). Wrapping the key with a Secure Enclave key (spec 11.1) needs a signed native helper, so it waits for plan 3b; the file format keeps a version byte for that change.
- **What is secret:** API keys and OAuth tokens go to the Keychain only. The settings file holds which providers are connected, base URLs, role choices and the last model used.
- **No new runtime dependencies** besides `@neelsatyavolu/shared-ai-auth` (already named in plan 3a). Input validation is hand-written at the API boundary.
- **One OpenAI-compatible Chat Completions adapter** covers OpenRouter, Ollama, LM Studio, custom endpoints and Gemini (Google's OpenAI-compatible endpoint). Gemini's thought signatures ride on tool calls as opaque `meta`, so multi-step tool use works.
- **The Responses adapter** also serves the OpenAI API (API key) and the xAI API (API key).
- **Claude Code** is a runner, not a `Model`: roles may name it, and `modelFor` returns `{ runner: "claude-code", model }` so the caller uses `runClaudeCode`.
- **Default preference order** when several providers are connected **[builder call]**: ChatGPT, Claude Code, Grok (subscriptions the user already pays for), then Anthropic, OpenAI, xAI, Google, OpenRouter, the custom endpoint, LM Studio, Ollama.

## File layout

```
perchd/src/config/
  keychain.ts      Keychain interface, Bun.secrets implementation, in-memory mock
  crypto.ts        AES-256-GCM seal/open with a versioned header
  store.ts         encrypted settings store: load, validate, update, atomic write
perchd/src/models/
  providers.ts     provider table: kind, auth, base URLs, default models per role
  catalog.ts       model capability data (vision, tools, context, efforts, image output) and parsing of /models replies
  chat-completions.ts  OpenAI-compatible adapter
  responses.ts     (extended) OpenAI and xAI API keys
  oauth.ts         ChatGPT and Grok sign-in, refresh, sign-out; loopback.ts for the callback
  roles.ts         the six roles: defaults, validation, fallbacks
  images.ts        image generation adapters, files into the chat folder
  connection.ts    connection test per provider
  registry.ts      the typed API the settings page calls
perchd/test/
  config.test.ts  roles.test.ts  oauth.test.ts  images.test.ts  registry.test.ts  chat-completions.test.ts
  fixtures/fake-providers.ts   one Bun.serve fake for every provider's HTTP API
```

## Tasks

1. Keychain module and mock; crypto seal/open; encrypted store. Tests: round trip, wrong key and tampering fail, file is 0600 and contains no plaintext, unreadable file is set aside, validation rejects bad shapes.
2. Provider table and capability catalog. Tests: known ids get the right capabilities, OpenRouter and Gemini `/models` replies are parsed into capabilities, unknown ids get safe defaults.
3. Chat Completions adapter. Tests against the fake server: streamed text, streamed tool-call arguments, images in tool results, Gemini thought signatures round-trip, 401 hint without the key.
4. Responses adapter for API keys (OpenAI, xAI). Tests: URL, auth header, body shape.
5. ChatGPT and Grok sign-in. Tests with a fake token endpoint: PKCE URL, loopback callback, pasted code, wrong state, refresh before expiry, a failed refresh marks the provider expired, sign-out removes the Keychain item.
6. Roles. Tests: defaults per provider set, explicit choice kept, fallback when the provider is gone, Visual only with vision, Image only with image output, effort validated, last used becomes Default.
7. Image generation. Tests against the fake server for OpenAI, xAI, Gemini and ChatGPT: request shape, files written in the chat folder with safe names, errors in plain words.
8. Connection test and the registry API. Tests: list providers, set key (checked before saving, rejected key not stored), sign out, list models with fallback, set role, `modelFor` returns a working `Model` against the fake server, no secret appears in settings file, errors or results.
9. `cli.ts` uses the registry for `--model codex|grok|<provider>:<model>`. Docs: README layout table.

## Deferred, and why

- **Secure Enclave wrapping of the settings key:** needs a signed native helper (plan 3b, Chromium track).
- **Settings → Models page itself:** WebUI in plan 3b; this plan ships the API it calls.
- **Device-code sign-in for ChatGPT** (Aside's newest flow): `shared-ai-auth` supports PKCE only; adding device code belongs in that repo (spec 16).
- **Fast mode wiring per provider** (priority tier): stored per role now; adapters send it once each provider's parameter is confirmed against the live API.
- **Image editing** (input image plus prompt): generation ships now; editing needs the chat attachment model from plan 3b.
- **GitHub Copilot and Kimi subscriptions:** no flow the terms allow for a third-party open-source app.
