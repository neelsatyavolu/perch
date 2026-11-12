// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webkit_tab/webkit_tab_throttle.h"

#include <memory>

#include "chrome/browser/perch/webkit_tab/webkit_tab.h"
#include "chrome/browser/perch/webkit_tab/webkit_tab_rules.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/reload_type.h"
#include "content/public/browser/web_contents.h"
#include "net/base/net_errors.h"

namespace perch {

// static
void WebKitTabThrottle::MaybeCreateAndAdd(
    content::NavigationThrottleRegistry& registry) {
  if (registry.GetNavigationHandle().IsInPrimaryMainFrame()) {
    registry.AddThrottle(std::make_unique<WebKitTabThrottle>(registry));
  }
}

WebKitTabThrottle::WebKitTabThrottle(
    content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

WebKitTabThrottle::~WebKitTabThrottle() = default;

content::NavigationThrottle::ThrottleCheckResult
WebKitTabThrottle::WillStartRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult
WebKitTabThrottle::WillRedirectRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult WebKitTabThrottle::Check() {
  content::NavigationHandle* handle = navigation_handle();
  if (!UsesWebKit(handle->GetURL())) {
    return PROCEED;
  }
  content::WebContents* contents = handle->GetWebContents();
  WebKitTab* existing = WebKitTab::FromWebContents(contents);
  content::ReloadType reload = handle->GetReloadType();
  if (existing && reload != content::ReloadType::NONE) {
    existing->Reload(reload == content::ReloadType::BYPASSING_CACHE);
  } else {
    WebKitTab::CreateForWebContents(contents);
    WebKitTab::FromWebContents(contents)->Load(handle->GetURL());
  }
  return {BLOCK_REQUEST, net::ERR_BLOCKED_BY_CLIENT, PlaceholderHtml()};
}

const char* WebKitTabThrottle::GetNameForLogging() {
  return "PerchWebKitTabThrottle";
}

}  // namespace perch
