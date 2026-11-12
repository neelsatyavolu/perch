# WebKit player tabs (Netflix without a VMP signature)

## Why

Netflix refuses Perch: no Widevine VMP signature, so it never requests a licence and then signs the user out. Tested 2026-11-12 on macOS 27.3: a plain WKWebView plays Netflix through FairPlay, which macOS gives every app. No signature, no fee, no workaround of any DRM check. Codex and Grok were consulted; both rejected an Electron rewrite.

## What the user sees

Netflix opens in a normal Perch tab. Tab strip, toolbar and address bar stay above it and look the same. Only the page area is rendered by WebKit instead of Chromium. The first time, the user signs in to Netflix once more (WebKit keeps its own cookies). Back, forward, reload, title, favicon, audio indicator and fullscreen work as in any tab.

Not available on these pages: Chrome extensions, the sidebar agent acting on the page, find-in-page (phase 2), split view (the tab opens unsplit).

## Design

All new code lives in `overlay/chrome/browser/perch/webkit_tab/` plus a small patch for the hooks Chromium needs. Nothing touches the tab model.

1. **Routing.** A `NavigationThrottle` on main-frame navigations to hosts in a list (`netflix.com` to start) cancels the Chromium load and navigates the tab to `perch://player/?u=<url>`, a tiny static page. Chromium never runs Netflix, so no double session and no sign-out loop. Links from Netflix to other hosts go back to Chromium.
2. **Per-tab WebKit view.** `WebKitTabHelper` (a `WebContentsUserData`) owns one `WKWebView` and its delegates. It mirrors the WebKit page's title, URL, favicon, loading state and audio into the tab, and maps Perch's back, forward, reload and stop onto WebKit.
3. **Placement.** A `views::NativeViewHost` sits over the contents view in `BrowserView`. When the active tab has a helper, it attaches that tab's `WKWebView` and shows; otherwise it hides. Views layout keeps it aligned through resize, sidebar and tab switches, so there is no separate window to drift.
4. **Address bar.** Shows the real Netflix URL, not `perch://player`.
5. **Data.** One persistent `WKWebsiteDataStore` per Perch profile (`dataStoreForIdentifier:`), non-persistent for incognito. Clearing site data in Perch clears it too.
6. **Efficiency.** Tab sleeping discards the tab's `WebContents`, which destroys the helper and frees the WKWebView. FairPlay decodes in hardware.
7. **Fullscreen.** WebKit element fullscreen becomes Perch window fullscreen with the view filling it.
8. **DRM notice.** The "Google hasn't approved…" notice is skipped for hosts routed to WebKit.

## Steps

1. Spike: hardcode one WKWebView in a NativeViewHost over the contents area; check it lines up and redraws with the frame. Verify: screenshot; Netflix plays.
2. Throttle and `perch://player` page. Verify: unit test for host matching; netflix.com never loads in a renderer.
3. Tab helper: title, favicon, URL, loading, audio, back/forward. Verify: browser test where possible; manual check.
4. Address bar URL, fullscreen, sleep, incognito data store.
5. Release build, sign, notarize, install. Verify: user plays Netflix in Perch; Chromium tabs unaffected.
