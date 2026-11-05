# Perch plan 7: account, sync and relay server

**Goal:** A Cloudflare Worker at `api.perchbrowser.com` and `relay.perchbrowser.com` that holds optional Perch accounts, end-to-end encrypted sync data and the list of paired devices, and relays remote control and MCP traffic between paired devices. A client library in `perchd/src/sync/` encrypts everything with WebCrypto before it leaves the Mac. The server only ever sees ciphertext, sizes, timestamps and device ids (spec 11.3).

**Spec:** sections 9.3, 11.2, 11.3, 11.4. Roadmap row 7.

## Decision: encrypted blob protocol first, Chromium's sync protocol later

Spec 11.3 says browser data should use Chromium's sync engine against Perch's server, as Brave does with `brave/go-sync`. v1 uses Perch's own encrypted blob protocol for every data type instead:

- Chromium's protocol is large: `sync.proto` and its ~40 entity specifics, commit and get-updates with progress markers, Nigori key handling, and the server-side rules `go-sync` implements in about 10,000 lines of Go. Doing it well is its own plan.
- The client half needs Chromium patches (sync URL, Nigori custom passphrase forced on, Google sign-in removed). Those need Chromium builds, which belong to the Chromium track (plans 2 and 3b), not this one.
- `perchd` already reads and writes browser data over CDP and owns Perch's own data, so one encrypted protocol covers bookmarks, history, settings, memory, skills and open tabs today.
- The server can add a `/chromium-sync/` endpoint later without changing accounts, devices, keys or the relay. Chromium's custom passphrase gives the same property (server sees ciphertext only), so moving browser types over later does not weaken anything.

Passwords and extensions wait for that move: they live inside Chromium's encrypted stores, and copying them out through `perchd` would put password values in a second process.

## Aside parity checklist

Aside (aside.com) syncs nothing across devices in its own account; its remote control signs a cloud CLI in with an 8-character code approved in Settings and relays `aside exec --host` over Aside's relay. Perch's version:

| Aside | Perch | Here |
|---|---|---|
| `aside login`, 8-character code approved in Settings | `perch login` shows an 8-character code; Perch approves it and names the device | pairing endpoints, relay client |
| Remote `exec --host <device>` through Aside's relay | Relay Durable Object per account, ciphertext only between paired devices | `RelayRoom` |
| Devices listed in Settings, revocable | `GET /v1/devices`, `DELETE /v1/devices/:id` closes its relay socket and ends its sessions | devices routes |
| Relay sees plaintext (TLS to Aside) | End-to-end encrypted between devices; relay forwards ciphertext | `perchd/src/sync/channel.ts` |
| Account sign-in by email | Email magic link with an 8-character code fallback, and passkeys | auth routes |
| No cross-device sync | E2E encrypted sync of bookmarks, history, settings, memory, skills, open tabs | sync routes, `SyncEngine` |

## Security design

- **Keys.** The first device creates a random 256-bit sync key. Item encryption and item-id keys are derived from it with HKDF. Each device has a P-256 ECDH key pair; the sync key is wrapped for each device with ECIES (ephemeral ECDH, HKDF, AES-256-GCM). A recovery copy is wrapped with a key from the recovery key or passphrase (PBKDF2-SHA256, 600,000 iterations). The server stores wrapped keys only.
- **Items.** AES-256-GCM with additional data `perch-sync-v1|collection|itemId|version|keyVersion`, so the server cannot move a ciphertext to another item, collection or version. Item ids are HMACs of the real id (a URL hash never reaches the server).
- **Conflicts.** Each item has a version. A write names the version it was based on; the server applies it only when that is still current and sets version = base + 1, otherwise returns the current ciphertext. The client merges (last writer wins by time for settings, bookmarks, tabs; union for history; newer wins with the older kept as a conflict copy for memory and skills) and writes again.
- **Revocation.** Revoking a device deletes its sessions and wrapped key and closes its relay socket. The client then rotates the sync key (new version wrapped for the remaining devices) and re-encrypts in the background; the server refuses wraps for stale versions.
- **Pairing.** The new device's 8-character code is the first 40 bits of SHA-256 of its public key. The approving device checks the code against the key the server returns, so a dishonest server cannot swap in its own key. The sync key is wrapped only to a key checked this way.
- **Relay.** Messages are AES-256-GCM under a key derived from the two devices' static ECDH keys, with sender, recipient and a counter in the additional data; receivers reject repeated or old counters.
- **Server.** Bearer tokens only, no cookies, so there is no ambient credential for CSRF to use. JSON bodies must be `application/json`. The one HTML form (magic link confirm) takes the token in the body and changes only the sign-in request it names. Every endpoint has a rate limit (a Durable Object token bucket keyed by a hash of IP, account or email). All input is checked with zod. Logs carry route, status and event names only, never emails, IPs, tokens or ids. Secrets (Resend key) are Worker secrets; tokens are stored as SHA-256 hashes.
- **Limits** (spec 11.4): 100 MB per account by default (`QUOTA_BYTES`), 4 MB per item, 256 KB per relay frame. A full account gets a plain 413 message, never a silent drop.

## File layout

```
server/
  package.json  tsconfig.json  wrangler.jsonc  vitest.config.ts  README.md
  migrations/0001_init.sql
  src/
    index.ts            Worker entry: fetch, scheduled cleanup, Durable Object exports
    app.ts              Hono app, error handling, security headers
    env.ts              bindings and config
    http.ts             JSON body parsing with zod, errors, client IP
    log.ts              structured logs without PII
    crypto.ts           random tokens, hashing, base64url
    ratelimit.ts        RateLimiter Durable Object and rules
    mailer.ts           Mailer interface, Resend and capture implementations
    auth/session.ts     sessions and the auth middleware
    auth/email.ts       magic link and code sign-in
    auth/confirm-page.ts  the confirm page HTML
    auth/passkey.ts     WebAuthn registration and sign-in
    devices.ts          device list, rename, revoke
    keys.ts             wrapped keys, recovery copy, rotation
    sync.ts             commit, changes, blob reads, quota
    pairing.ts          start, lookup, approve, deny, poll
    relay.ts            RelayRoom Durable Object and upgrade route
    account.ts          account info and deletion
    cleanup.ts          expired rows, old tombstones
  test/                 vitest with @cloudflare/vitest-pool-workers
perchd/src/sync/
  encoding.ts  crypto.ts  keys.ts  api.ts  engine.ts  merge.ts  channel.ts  keychain.ts  types.ts
perchd/test/sync-*.test.ts
```

## Tasks

1. Scaffold `server/` (wrangler config with both hostnames, D1, R2, Durable Objects, cron), migration, test harness. Test: health route, unknown route 404, security headers.
2. Rate limiter Durable Object and rules. Test: bucket empties and refills; 429 with `Retry-After`.
3. Email sign-in: start, confirm page, confirm, code verify, poll; capture mailer in tests. Tests: link flow, code flow, expiry, attempts, GET never consumes, rate limits, no account enumeration.
4. Sessions and devices: bearer middleware, list, rename, revoke, sign out. Tests: revoked device loses access.
5. Passkeys with `@simplewebauthn/server`. Tests with a software authenticator (P-256, `none` attestation): register, sign in, counter, wrong origin.
6. Keys: wrapped keys per device, recovery copy, rotation. Tests: version rules, revoked devices.
7. Sync: commit with versions, changes with cursor, R2 for large items, quota, tombstones. Tests: conflicts, cursor paging, R2 round trip, quota 413.
8. Pairing. Tests: code bound to key, approve, poll once, expiry, attempt limits.
9. Relay Durable Object: WebSocket hibernation, routing by device, presence, size and rate limits, revocation closes sockets. Tests over real WebSockets in Miniflare.
10. Account deletion and scheduled cleanup.
11. `perchd/src/sync`: crypto, key wrapping, recovery, API client, engine with merge rules, relay channel, Keychain store. Bun tests, plus an end-to-end test that runs the client library inside the Worker test pool against the real routes.
12. Docs: server README (self-host deploy, secrets, limits, protocol), perchd README section.

## Deferred, and why

- **Chromium sync protocol**: see the decision above. Passwords and extensions sync after it lands.
- **Remote MCP by connector URL** for hosted assistants (spec 9.3, last but one bullet). A hosted assistant speaks plain MCP over HTTPS, so the relay would see tool traffic in readable form. That breaks the anti-goal in spec 4 unless the owner accepts it for this one opt-in feature. Remote MCP between paired devices (the remote `perch mcp --host` tunnels JSON-RPC through the encrypted channel) is built.
- **Forward secrecy on the relay channel**: v1 uses static-static ECDH with counters. An ephemeral handshake per connection is a small follow-up.
- **Wiring into the browser UI and `perch login`**: Settings pages and the CLI commands belong to plans 3b and 4; this plan ships the library they call.
- **Secure Enclave wrapping** of the device key: needs native code from the Chromium track. v1 keeps the device private key and sync key in the Keychain.
- **Deploying**: nothing is deployed. The owner runs the steps in `server/README.md`.
- **Company sign-in (OpenID Connect)**: plan 8.
