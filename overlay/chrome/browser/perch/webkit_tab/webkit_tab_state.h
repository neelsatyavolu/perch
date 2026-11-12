// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_STATE_H_
#define CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_STATE_H_

#include "base/supports_user_data.h"
#include "content/public/browser/web_contents.h"

namespace perch {

// What a WebKit tab (webkit_tab.h) tells Chromium's tab strip and address bar
// about the page it shows. Header-only, so the tab icon and security code can
// read it without linking the WebKit tab. Chromium's own placeholder page
// underneath is an error page; these replace its "error" and "not secure".
struct WebKitTabState : public base::SupportsUserData::Data {
  bool loading = false;
  // HTTPS with a valid certificate and no insecure content (WKWebView's
  // hasOnlySecureContent).
  bool secure = false;
};

inline constexpr char kWebKitTabStateKey = 0;

inline const WebKitTabState* GetWebKitTabState(
    const content::WebContents* contents) {
  return static_cast<const WebKitTabState*>(
      contents->GetUserData(&kWebKitTabStateKey));
}

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_STATE_H_
