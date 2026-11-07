// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SCHEME_PERCH_SCHEME_H_
#define CHROME_BROWSER_PERCH_SCHEME_PERCH_SCHEME_H_

class GURL;

namespace content {
class BrowserContext;
}

namespace perch {

inline constexpr char kPerchScheme[] = "perch";

// perch:// addresses open Chromium's chrome:// pages (spec 5.1):
// perch://settings is chrome://perch-settings, and any other perch://x is
// chrome://x, so perch://version and perch://extensions work, and
// chrome://newtab is chrome://perch-newtab. A BrowserURLHandler
// pair: the forward half rewrites perch:// to chrome:// and claims Perch's own
// chrome:// pages, and the reverse half shows them as perch:// again.
bool RewritePerchURL(GURL* url, content::BrowserContext* context);
bool ReversePerchURL(GURL* url, content::BrowserContext* context);

// Whether `url` is Perch's new tab page, which the omnibox treats as the NTP.
bool IsPerchNewTabURL(const GURL& url);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SCHEME_PERCH_SCHEME_H_
