// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webkit_tab/webkit_tab_rules.h"

#include <array>
#include <string_view>

#include "url/gurl.h"

namespace perch {

namespace {

// Each entry also covers its subdomains. Add a service only after it is
// tested in WebKit and recorded in docs/drm-status.md.
constexpr std::array<std::string_view, 1> kWebKitHosts = {"netflix.com"};

}  // namespace

bool UsesWebKit(const GURL& url) {
  if (!url.is_valid() || !url.SchemeIs("https")) {
    return false;
  }
  for (std::string_view host : kWebKitHosts) {
    if (url.DomainIs(host)) {
      return true;
    }
  }
  return false;
}

std::string PlaceholderHtml() {
  return "<!doctype html><meta charset=utf-8><meta name=color-scheme "
         "content=\"dark light\"><style>html{background:#0E0E0D}"
         "@media (prefers-color-scheme:light){html{background:#F7F5EF}}"
         "</style>";
}

}  // namespace perch
