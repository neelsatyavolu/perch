// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_ONBOARDING_ONBOARDING_H_
#define CHROME_BROWSER_PERCH_ONBOARDING_ONBOARDING_H_

class BrowserWindowInterface;
class GURL;

namespace content {
class WebContents;
}

namespace perch {

// First-run setup: a new profile's first window opens perch://welcome filling
// the whole screen, with the tab strip and toolbar hidden while that page is
// the active tab (hide_chrome.cc). It shows until the person finishes or
// skips it, also across restarts. --no-first-run turns it off (headless runs
// set it), unless --force-first-run is there too.

// Whether `url` is the welcome page.
bool IsWelcomeURL(const GURL& url);

// Opens the welcome page in `browser` and takes the window full screen,
// when its profile hasn't been through setup. Called once per window, after
// its first tabs are in.
void MaybeStartOnboarding(BrowserWindowInterface* browser);

// The welcome page in `welcome` is done (finished or skipped): never start it
// again, and leave full screen.
void FinishOnboarding(content::WebContents* welcome);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_ONBOARDING_ONBOARDING_H_
