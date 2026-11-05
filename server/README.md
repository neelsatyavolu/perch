# Perch server

Perch's optional account, sync and relay server: one Cloudflare Worker with D1, R2 and two Durable Objects. It serves `api.perchbrowser.com` and `relay.perchbrowser.com`.

The server stores only ciphertext, sizes, timestamps and device ids. Perch encrypts every synced item on the Mac before sending it (`perchd/src/sync`), and relay messages are encrypted between the two devices. The server cannot read bookmarks, history, settings, memory, skills, tabs or relayed commands.

Design and decisions: `docs/superpowers/plans/2026-11-05-perch-sync-server.md`. Spec sections 9.3 and 11.

## What it does

| Area | Routes | Notes |
|---|---|---|
| Email sign-in | `POST /v1/auth/email/start`, `verify`, `poll`, `confirm/info`, `confirm`; `GET /v1/auth/email/confirm` | The email has a link and an 8-character code. The link page asks the person to type the number their device shows (a wrong number cancels), so a stray click cannot sign in someone else's device. The link token sits in the URL fragment and never reaches server logs. Sessions go only to the device that holds the poll secret. |
| Passkeys | `POST /v1/auth/passkey/register/options`, `register/verify`, `login/options`, `login/verify`; `GET`, `DELETE /v1/auth/passkey[/:id]` | WebAuthn with user verification required, through `@simplewebauthn/server`. Relying party `perchbrowser.com`. |
| Account | `GET`, `DELETE /v1/account`, `POST /v1/account/confirm` | Deleting removes every row and R2 object and closes relay sockets. Deleting the account and adding a passkey need a fresh code emailed to the account address (`/confirm`), not just a session. |
| Devices | `GET /v1/devices`, `PATCH`, `DELETE /v1/devices/:id` | Revoking deletes the device's sessions and key copy and closes its relay socket. |
| Keys | `GET /v1/keys`, `PUT /v1/keys/devices/:id`, `PUT /v1/keys/recovery`, `POST /v1/keys/rotate` | Wrapped copies of the sync key, one per device plus a recovery copy. Versions only go up. |
| Sync | `POST /v1/sync/:collection/commit`, `GET /v1/sync/:collection/changes`, `GET /v1/sync/:collection/items/:id/blob`, `GET /v1/sync/usage` | Collections: bookmarks, history, settings, memory, skills, tabs, chats, artifacts. Per-item versions; a write applies only on the version it was based on. Items over 64 KB go to R2. |
| Pairing | `POST /v1/pair/start`, `GET /v1/pair/lookup`, `POST /v1/pair/:id/approve`, `/deny`, `POST /v1/pair/poll` | The new device shows a 16-character code; the server sees only the first half, a commitment to the device's key and to the second half (a secret). The approving device checks the key against the whole code and leaves a grant sealed with the secret, which the server passes along but cannot read or forge. A request that is still waiting is never replaced. |
| Relay | `GET /v1/relay` (WebSocket) | One `RelayRoom` Durable Object per account forwards `{t:"msg", to, d}` frames between online devices, with presence updates. |

Only Perch browsers can change the account. A paired remote CLI (Grok Bot's computer, `perch login` elsewhere) can use the relay, read the account and device list, and remove itself.

## Security properties

- No cookies and no CORS. API calls carry `Authorization: Bearer`, so a page on another site has no credential to use (CSRF). JSON bodies must be `application/json`, which an HTML form cannot send. The one HTML page (the sign-in confirm page) has a nonce-based CSP and takes its token from the fragment.
- Tokens, codes and poll secrets are stored as SHA-256 hashes. Sessions last 90 days and extend while used.
- Every endpoint has a rate limit: a token bucket per hashed IP, email, account or device, in the `RateLimiter` Durable Object (see `RULES` in `src/ratelimit.ts`). The relay also caps each socket at 200 frames per 10 seconds and 256 KB per frame.
- Input is checked with zod at every route.
- Logs carry the event name, route pattern, method, status and timing only (`src/log.ts`). Workers invocation logs are off.
- Limits: 100 MB per account (`QUOTA_BYTES`), 4 MB per item, 100 items per commit. A commit answers 200 with a result per item; an item that does not fit gets `status: "quota"`, so one full item never fails the rest of the commit. The client reports these items as not synced.
- A daily cron deletes expired sign-in requests, challenges, pairings and sessions, and deletion markers older than 90 days. A device that was away longer than that is told to sync from the start.

## Develop and test

```sh
cd server
bun install
bunx vitest run          # Miniflare (workerd) with local D1, R2 and Durable Objects
bunx tsc --noEmit -p .
```

The tests never send email: they pass a capture mailer to `createApp`. Passkey tests use a software authenticator (`test/webauthn.ts`). `test/client-e2e.test.ts` runs perchd's sync client against the real routes inside workerd.

After changing `wrangler.jsonc`, run `bunx wrangler types`.

## Deploy (owner only)

Agents never deploy this. On a machine signed in to the Cloudflare account that holds `perchbrowser.com`:

```sh
cd server
bunx wrangler d1 create perch            # put the printed database_id in wrangler.jsonc
bunx wrangler r2 bucket create perch-sync
bunx wrangler d1 migrations apply perch --remote
bunx wrangler secret put RESEND_API_KEY  # from 1Password; never in a file
bunx wrangler deploy
```

Before the first deploy:

1. In Resend, verify `perchbrowser.com` as a sending domain (SPF and DKIM records) so `sign-in@perchbrowser.com` can send. Without `RESEND_API_KEY`, email sign-in answers 503 and passkeys still work.
2. Passkeys need the sign-in page to be served from an origin in `PASSKEY_ORIGINS` (`https://perchbrowser.com` or `https://api.perchbrowser.com`). A native macOS passkey prompt also needs an `apple-app-site-association` file on `perchbrowser.com` listing Perch's app id under `webcredentials`.
3. `wrangler deploy` creates the `api.` and `relay.` custom domains on the zone.

## Self-hosting

Anyone can run their own copy (spec 11.4 and 12.3): change the hostnames in `routes`, `API_ORIGIN`, `RP_ID`, `PASSKEY_ORIGINS` and `MAIL_FROM`, then follow the deploy steps. Point Perch at it with the `SyncServerURL` policy or Settings. Data stays end-to-end encrypted on a self-hosted server too.
