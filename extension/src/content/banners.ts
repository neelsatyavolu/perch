/** Content script: rejects cookie banners. Registered only while the feature is on, and never on exempt sites. */

import { watchForBanners } from "../banners/engine";

watchForBanners(
  document,
  (cmp) => {
    chrome.runtime.sendMessage({ type: "banner", cmp }).catch(() => undefined);
  },
  { shadowRootOf: (host) => chrome.dom.openOrClosedShadowRoot(host as HTMLElement) ?? null },
);
