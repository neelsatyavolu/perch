// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_H_
#define CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_H_

#include <memory>
#include <string>

#include "base/memory/weak_ptr.h"
#include "content/public/browser/web_contents_observer.h"
#include "content/public/browser/web_contents_user_data.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace gfx {
class Image;
}

namespace perch {

// Shows a tab's page in a WKWebView laid over the tab's own Chromium view,
// for sites in webkit_tab_rules (Netflix). Chromium commits a blank
// placeholder at the real URL underneath, so the tab strip, address bar,
// reload and session restore all work as for any tab; this class mirrors the
// WebKit page's title, address and favicon onto that placeholder.
//
// The WKWebView lives inside the WebContents' NSView, so Chromium's own
// layout moves, resizes and swaps it with the tab. Sleeping or closing the tab
// destroys the WebContents and with it this object and the WKWebView.
class WebKitTab : public content::WebContentsUserData<WebKitTab>,
                  public content::WebContentsObserver {
 public:
  WebKitTab(const WebKitTab&) = delete;
  WebKitTab& operator=(const WebKitTab&) = delete;
  ~WebKitTab() override;

  // Shows `url` in WebKit (a new address in this tab).
  void Load(const GURL& url);
  // Reloads the WebKit page (the reload button on the placeholder).
  void Reload(bool bypass_cache);

  // From the WebKit page.
  void OnTitleChanged(const std::u16string& title);
  void OnURLChanged(const GURL& url);
  void OnPageStateChanged(bool loading, bool secure);
  void OnFaviconLoaded(const GURL& icon_url, const gfx::Image& image);
  // A link that leaves the WebKit sites, or asks for a new window.
  void OpenInChromium(const GURL& url, WindowOpenDisposition disposition);

 private:
  friend class content::WebContentsUserData<WebKitTab>;
  struct Cocoa;

  explicit WebKitTab(content::WebContents* web_contents);

  // content::WebContentsObserver:
  void PrimaryPageChanged(content::Page& page) override;
  void WebContentsDestroyed() override;
  void RenderFrameHostChanged(content::RenderFrameHost* old_host,
                              content::RenderFrameHost* new_host) override;
  void OnWebContentsFocused(
      content::RenderWidgetHost* render_widget_host) override;

  // Puts the WKWebView on top of the tab's view and fills it.
  void Attach();
  // Copies the WebKit page's title and address onto the placeholder entry.
  void SyncEntry();
  // The tab left the WebKit sites: drop the WKWebView and this object.
  void DetachSoon();

  std::unique_ptr<Cocoa> cocoa_;
  // False once the tab has left the WebKit sites and is waiting to be freed.
  bool active_ = true;
  std::u16string title_;
  GURL url_;
  base::WeakPtrFactory<WebKitTab> weak_factory_{this};

  WEB_CONTENTS_USER_DATA_KEY_DECL();
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_H_
