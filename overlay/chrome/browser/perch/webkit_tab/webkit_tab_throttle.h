// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_THROTTLE_H_
#define CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_THROTTLE_H_

#include "content/public/browser/navigation_throttle.h"

namespace perch {

// Sends a tab's navigation to a WebKit site (webkit_tab_rules) to the tab's
// WKWebView, and has Chromium commit a blank placeholder at that URL instead,
// so Chromium never loads the site itself.
class WebKitTabThrottle : public content::NavigationThrottle {
 public:
  static void MaybeCreateAndAdd(content::NavigationThrottleRegistry& registry);

  explicit WebKitTabThrottle(content::NavigationThrottleRegistry& registry);
  ~WebKitTabThrottle() override;

  // content::NavigationThrottle:
  ThrottleCheckResult WillStartRequest() override;
  ThrottleCheckResult WillRedirectRequest() override;
  const char* GetNameForLogging() override;

 private:
  ThrottleCheckResult Check();
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_THROTTLE_H_
