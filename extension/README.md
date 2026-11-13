# Perch built-in extension

The parts of spec 5.9 ("what Chrome is missing") that need no Chromium changes, as one Manifest V3
extension. It loads unpacked in Chrome for Testing today; the Chromium build will register `dist/`
as a component extension, so it cannot be removed and updates with Perch.

No remote code, no telemetry. The only network requests it makes are the link previews you ask for
(sent without cookies), and `bun run lists` at build time.

## Features

| Feature | How |
|---|---|
| Ad and tracker blocking | EasyList, EasyPrivacy, uBlock filters – Privacy and Peter Lowe's list compiled to `declarativeNetRequest` static rulesets at build time (`src/rules`). Their element-hiding filters compile to `cosmetic/generic.css` (a dynamic content script at document start) and `cosmetic/sites.json` (inserted per frame as a user stylesheet on commit) (`src/cosmetic`); procedural filters and scriptlets are skipped. Off for one site from the panel, everywhere from Settings. |
| Cookie banners | Reject-only rules for OneTrust, Didomi, Quantcast, TrustArc, Cookiebot, Usercentrics, Sourcepoint and others (`src/banners`). A control that reads as accepting is never clicked. |
| Tracking parameters | One DNR `removeParams` rule on page loads (`src/params`), plus "Copy link without tracking" in the link menu. |
| Reader view | Mozilla Readability, sanitised, in a closed shadow root. Menu, panel, or ⌃⇧R. |
| Video | Picture in picture when a playing video with sound is hidden; `[` and `]` change speed; speed menu on videos; ⌃⇧P. |
| Link preview | Hold Shift over a link: title, description, image and the cleaned address, with "Open in new tab". A public page cannot preview loopback, LAN or intranet addresses: the host check covers trailing dots and single-label names, and a session rule blocks the worker's own requests to private addresses on every redirect hop. The image is fetched by the worker and shown as a `data:` URL. |
| Full-page screenshot | Scroll-and-stitch capture, then a markup page (pen, box, undo, copy, save). ⇧⌘2. |
| Authenticator | TOTP codes (RFC 6238). Each account is encrypted whole with AES-256-GCM under a non-extractable key; stored in `storage.local`, never `storage.sync`. QR import from the visible page; fill only on the site the code was added from. The key comes from Perch over native messaging (`co.xanom.perch.keys`); without it the authenticator is off (see Limits). |
| Site panel | Blocked counts, cookie-banner result, protections switch, permissions, cookie count and "Forget this site". |

## Commands

```sh
bun install
bun run lists        # download the filter lists into .cache/lists (gitignored)
bun run build        # bundle, copy static files and icons, compile rules into dist/
bun test             # unit tests, then integration tests in headless Chrome for Testing
bun run typecheck
```

`bun run build -- --refresh` downloads fresh lists first. `dist/rules/meta.json` records each list's
version and SHA-256, rule counts, element-hiding counts and what the compilers skipped. The integration tests use the small lists in
`test/fixtures/lists`; `test/integration/real-lists.test.ts` also checks the real lists when they
have been downloaded. Integration tests need Chrome for Testing (see `perchd`).

## Limits, on purpose

- Network blocking only. Element hiding (`##` rules) and run-time list updates belong in the native
  `adblock-rust` engine spec 5.9 names; until then lists update with Perch releases.
- Regex filters and options the compiler does not understand are skipped and counted.
- Automatic picture in picture needs a recent user gesture in stock Chromium; the Perch build turns
  on Chromium's browser-initiated automatic picture in picture to cover the rest.
- Link preview cannot see what a public name resolves to, so a public name pointing at a private
  address gets through. The Perch build should apply Chromium's local network access checks to
  the extension's fetches in the network service. Arc-style peek (a live page in a floating card
  that expands into a tab) needs a WebContents in a bubble and is left to the Chromium build; the
  extension shows a metadata card.
- Screenshots scroll the page. The Perch build can use `Page.captureScreenshot` with
  `captureBeyondViewport` instead.
- The authenticator's key comes from the browser: Perch answers `{op: "authenticator"}` on the
  native messaging host `co.xanom.perch.keys` with a key derived from the profile's Keychain-wrapped
  root key, and only for this component extension. The extension keeps it in memory as a
  non-extractable CryptoKey. Without that answer, an unpacked install (development, Chrome for
  Testing, the integration tests; `chrome.management.getSelf().installType === "development"`)
  keeps a key in IndexedDB next to the records, which is not safe; any other install turns the
  authenticator off. When Perch's key appears, records made under an IndexedDB key are re-encrypted
  under it and the old key is deleted. `otpauth-migration://` (Google Authenticator export) and
  HOTP are not supported.
- perchd's agent fills codes with `perchFillCode(tabId, frameUrl)` on the service worker, which
  answers only `"filled"`, `"no-code"` or `"no-field"`, never the code.

## Needs native code (Chromium plan)

| Feature | Approach in the Chromium build |
|---|---|
| Command bar (⌘K) | A WebUI page in a top-level bubble, fed by the omnibox providers (tabs, history, bookmarks) plus Perch commands and chats. |
| Copy URL (⇧⌘C) and as Markdown (⌥⇧⌘C) | Accelerators in `chrome/browser/ui/views/accelerator_table` mapped to new browser commands. |
| Tab tools | Browser commands on `TabStripModel`: close duplicates, close by last-active age, mute from the tab's audio indicator, tab search (already in Chromium). |
| Spaces | Named sets on saved tab groups (`SavedTabGroupKeyedService`), one list per profile, with a switcher in the tab strip. |
| HTTPS-only | Turn on Chromium's HTTPS-First mode (`kHttpsOnlyMode` pref) by default. |
| Encrypted DNS | Default `dns_over_https.mode` to automatic with a DoH template; system resolver fallback. |
| Fingerprinting protection | Reduced user-agent, third-party cookie blocking, and the privacy budget features, set through default prefs and feature flags. |
| On-device translation | Chromium's on-device translation models (`components/translate` with the local translator), never the Google endpoint. |
| Site panel in the address bar | Anchor the panel to the page-info icon instead of the toolbar; add "dark mode for this site" through the Auto Dark Mode content setting. |
| Ad blocking at full strength | `adblock-rust` in the network service for cosmetic filtering and list updates without a release. |
