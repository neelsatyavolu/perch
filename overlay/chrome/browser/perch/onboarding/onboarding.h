// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_ONBOARDING_ONBOARDING_H_
#define CHROME_BROWSER_PERCH_ONBOARDING_ONBOARDING_H_

class BrowserWindowInterface;
class GURL;
class Profile;

namespace perch {

// First-run setup: a new profile's first window opens perch://welcome filling
// the whole window, with the tab strip and toolbar hidden while that page is
// the active tab (hide_chrome.cc). It shows until the person finishes or
// skips it, also across restarts. --no-first-run turns it off (headless runs
// set it), unless --force-first-run is there too.

// Whether `url` is the welcome page.
bool IsWelcomeURL(const GURL& url);

// Opens the welcome page in `browser` and makes the window fill the screen,
// when its profile hasn't been through setup. Called once per window, after
// its first tabs are in.
void MaybeStartOnboarding(BrowserWindowInterface* browser);

// The welcome page is done (finished or skipped): never start it again.
void MarkOnboardingFinished(Profile* profile);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_ONBOARDING_ONBOARDING_H_
