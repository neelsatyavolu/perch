// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/scheme/perch_scheme.h"

#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include "content/public/common/url_constants.h"
#include "url/gurl.h"

namespace perch {

namespace {

// perch:// host, chrome:// host.
constexpr std::pair<std::string_view, std::string_view> kPages[] = {
    {"settings", "perch-settings"}, {"newtab", "perch-newtab"},
    {"memory", "perch-memory"},     {"routines", "perch-routines"},
    {"import", "perch-import"},     {"welcome", "perch-welcome"},
    {"chat", "perch-chat"},         {"tour", "perch-tour"},
};

std::optional<std::string_view> ChromeHostFor(std::string_view perch_host) {
  for (const auto& [perch, chrome] : kPages) {
    if (perch == perch_host) {
      return chrome;
    }
  }
  return std::nullopt;
}

std::optional<std::string_view> PerchHostFor(std::string_view chrome_host) {
  for (const auto& [perch, chrome] : kPages) {
    if (chrome == chrome_host) {
      return perch;
    }
  }
  return std::nullopt;
}

GURL WithSchemeAndHost(const GURL& url,
                       std::string_view scheme,
                       std::string_view host) {
  GURL::Replacements replacements;
  replacements.SetSchemeStr(scheme);
  replacements.SetHostStr(host);
  return url.ReplaceComponents(replacements);
}

}  // namespace

bool RewritePerchURL(GURL* url, content::BrowserContext* context) {
  // A new tab opens Perch's own page, never a search engine's remote one.
  // An enterprise or extension override registered earlier still wins.
  // Google's new tab page hosts too.
  if (url->SchemeIs(content::kChromeUIScheme) &&
      (url->host() == "newtab" || url->host() == "new-tab-page" ||
       url->host() == "new-tab-page-third-party")) {
    *url = WithSchemeAndHost(*url, content::kChromeUIScheme, "perch-newtab");
    return true;
  }
  if (url->SchemeIs(content::kChromeUIScheme)) {
    // Perch's own pages: claimed so the reverse half shows them as perch://.
    return PerchHostFor(url->host()).has_value();
  }
  if (!url->SchemeIs(kPerchScheme) || url->host().empty()) {
    return false;
  }
  const std::string host(url->host());
  *url = WithSchemeAndHost(*url, content::kChromeUIScheme,
                           ChromeHostFor(host).value_or(host));
  return true;
}

bool ReversePerchURL(GURL* url, content::BrowserContext* context) {
  if (!url->SchemeIs(content::kChromeUIScheme) || url->host().empty()) {
    return false;
  }
  const std::string host(url->host());
  *url = WithSchemeAndHost(*url, kPerchScheme,
                           PerchHostFor(host).value_or(host));
  return true;
}

bool IsPerchNewTabURL(const GURL& url) {
  return url.SchemeIs(content::kChromeUIScheme) && url.host() == "perch-newtab";
}

}  // namespace perch
