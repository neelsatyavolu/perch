// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_RULES_H_
#define CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_RULES_H_

#include <string>

class GURL;

namespace perch {

// Sites that refuse Perch's Widevine (no VMP signature) but play in WebKit
// through FairPlay, which macOS gives every app. A tab on one of these shows
// the page in a WKWebView instead of Chromium (plan 2026-11-12).
bool UsesWebKit(const GURL& url);

// What Chromium commits in such a tab underneath the WebKit view: a blank
// page in Perch's background colour, so a resize never flashes white.
std::string PlaceholderHtml();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBKIT_TAB_WEBKIT_TAB_RULES_H_
