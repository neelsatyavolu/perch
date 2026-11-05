# Perch built-in extension (spec 5.9 without C++)

**Spec:** `docs/superpowers/specs/2026-11-02-perch-design.md`, section 5.9. **Branch:** `perch/extension`.

## Goal

Ship the "what Chrome is missing" features that need no Chromium changes as one Manifest V3 extension in `extension/`. Today it loads unpacked into Chrome for Testing; plan 2 (Shell) later registers the built `extension/dist` as a component extension, so it cannot be uninstalled, updates with Perch releases and gets its off switches in Settings. Small and fast: no remote code, no telemetry, no network requests except the link preview the user asks for.

## Aside parity and what Perch adds

Aside's browser (docs.aside.com, changelog to v1.0.1022) has auto picture-in-picture (off by default), site settings that open Chrome's pages, and a password manager. It has no content blocker, cookie-banner handling, parameter stripping, reader view, link preview, full-page screenshot or one-time-code generator.

| Feature | Aside | Perch extension |
|---|---|---|
| Ad and tracker blocking | no | EasyList + EasyPrivacy compiled to declarativeNetRequest at build time, per-site off switch |
| Cookie banners | no | Reject-only rules for OneTrust, Didomi, Quantcast, TrustArc, Cookiebot, Usercentrics, Sourcepoint, plus Google Funding Choices, CookieYes, Complianz, Osano, iubenda, Axeptio, Termly |
| Tracking parameters | no | DNR `removeParams` on navigations; "Copy clean link" in the link menu |
| Reader view | no | Mozilla Readability, set in Geist / Geist Serif with Perch tokens |
| Picture in picture | auto, off by default | auto when a playing video's tab is hidden, on by default; `[` `]` speed keys; speed menu on videos |
| Link preview | no | Shift + hover on a link shows a card (title, description, image, cleaned URL) with Open |
| Full-page screenshot | no | stitched capture, markup page (pen, box, undo), save and copy; ⇧⌘2 |
| Authenticator | password manager only | TOTP codes, AES-GCM encrypted with a non-extractable key, QR import from the page, fill only on the matching site |
| Per-site panel | Chrome's site settings | blocker counts, banner result, permissions, cookies, "Forget this site", tools |

## File layout

```
extension/
  package.json, tsconfig.json, README.md
  static/            manifest.json, popup.html, options.html, shot.html, ui.css, icons/
  scripts/build.ts   bundles src with Bun.build, copies static, compiles rules -> dist/
  scripts/lists.ts   downloads EasyList/EasyPrivacy into .cache/lists (gitignored)
  src/rules/         parse.ts (ABP syntax), compile.ts (to DNR, grouping, limits)
  src/params/        list.ts (maintained names), strip.ts (pure strip + DNR rule)
  src/totp/          base32.ts, totp.ts (RFC 6238), otpauth.ts, vault.ts (encrypted store)
  src/banners/       rules.ts (CMP data), engine.ts (runs steps, never accepts)
  src/preview/       meta.ts (HTML metadata parse, address guard)
  src/shot/          tiles.ts (capture plan, pure)
  src/background/    index.ts and one module per feature, messages.ts (validated protocol)
  src/content/       banners.ts, media-pip.ts, media-speed.ts, preview.ts, reader.ts
  src/ui/            popup.ts, options.ts, shot.ts, dom.ts
  test/unit/         rule compiler, params, TOTP vectors, vault, banner rules, tiles, meta
  test/integration/  unpacked extension in headless Chrome for Testing against fixture pages
```

## Design decisions

- **Content scripts are registered dynamically** (`chrome.scripting.registerContentScripts`) from settings, with `excludeMatches` for sites whose protections are off. Turning a feature off unregisters its script, so pages pay nothing for it and never read storage on load.
- **Rule budget**: static rulesets `easylist`, `easyprivacy`, `params`. Plain `||host^` filters with the same options are merged into one rule with `requestDomains`, which keeps the total far under the 30,000 guaranteed static rules. The compiler skips regex filters, cosmetic filters, `$popup`, `$csp`, `$redirect`, `$removeparam`, entity domains (`example.*`) and any option it does not understand, and the build prints the counts. Exceptions outrank blocks; `$important` outranks exceptions; the per-site switch is a dynamic `allowAllRequests` rule above all of them.
- **Message protocol** is validated in one place. Content scripts may only report a banner result, ask for a link preview and open a previewed link. Everything touching codes, settings or captures is accepted only from the extension's own pages.
- **Authenticator**: each account record is encrypted whole (issuer, account, secret) with AES-256-GCM under a non-extractable key kept in IndexedDB, stored in `chrome.storage.local` (never `storage.sync`). Codes are filled only into the tab whose site matches the account; elsewhere they can only be copied. In the Chromium build the key moves behind the Keychain / Secure Enclave wrap from spec 11.1.
- **Link preview** fetches with `credentials: "omit"`, follows redirects, reads at most 512 KB, and refuses loopback and private addresses unless the page itself is on one.

## Tasks

1. Package skeleton, build script, manifest, icons. Verify: `bun run build` writes `dist/`.
2. Rule compiler (TDD: parse, options, grouping, limits, validation). Lists script and real-list build report.
3. Tracking parameters (TDD: strip function, DNR rule) and per-site switch.
4. Background: settings, content-script registration, messages, per-tab state. Integration: blocker and params on fixture pages, per-site off.
5. Cookie banners (TDD on rule data shape; integration on OneTrust, Usercentrics shadow DOM, Sourcepoint iframe, Quantcast two-step and accept-only fixtures).
6. Media: auto picture in picture, speed keys, speed menu. Integration on a video fixture.
7. Reader view. Integration on an article fixture.
8. Link preview. Unit tests for metadata parsing and the address guard; integration hover test.
9. Full-page screenshot and markup page. Unit tests for the tile plan; integration checks the stitched size.
10. Authenticator: RFC 6238 vectors, base32, otpauth, vault; integration QR import and fill.
11. Popup (per-site panel) and options page, following `DESIGN.md`.
12. Full `bun test` in `extension/` and `perchd/`, typecheck, report.

## Deferred, and why

- **Cosmetic filtering** (EasyList `##` rules): network blocking covers ads and trackers; element hiding at EasyList scale belongs in the native `adblock-rust` engine that spec 5.9 names, where it costs no extension script per page. Filter list updates likewise arrive with Perch releases until that engine lands, because static rulesets cannot change at run time.
- **Regex filters**: few in the lists, each costs the 1,000-regex budget and memory; skipped.
- **Google Authenticator export QR** (`otpauth-migration://`) and HOTP: rare; plain `otpauth://totp` covers sites.
- **Native-only features** (command bar, tab tools, Spaces, HTTPS-only, DNS over HTTPS, fingerprinting protection, on-device translation, copy URL shortcuts, the per-site panel's address-bar anchor) are listed with their Chromium approach in the report and the extension README.
