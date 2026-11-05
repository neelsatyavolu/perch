/**
 * Content script: rejects cookie banners. Registered only while the feature is on, and never on
 * exempt sites. A frame inside another page first asks whether the tab's site is exempt, because
 * the registration's exclusions only see the frame's own address.
 */

import { watchForBanners } from "../banners/engine";

type Reply = { ok: true; value: unknown } | { ok: false; error: string };

function watch(): void {
  watchForBanners(
    document,
    (cmp) => {
      chrome.runtime.sendMessage({ type: "banner", cmp }).catch(() => undefined);
    },
    { shadowRootOf: (host) => chrome.dom.openOrClosedShadowRoot(host as HTMLElement) ?? null },
  );
}

if (window === window.top) {
  watch();
} else {
  void chrome.runtime
    .sendMessage({ type: "banner-allowed" })
    .then((reply: Reply | undefined) => reply?.ok === true && reply.value === true && watch())
    .catch(() => undefined);
}
