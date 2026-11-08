// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEP_CONTROLLER_H_
#define CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEP_CONTROLLER_H_

#include <vector>

#include "chrome/browser/perch/memory_saver/sleep_rules.h"

class GURL;
class Profile;

namespace base {
class UnguessableToken;
}

namespace tabs {
class TabInterface;
}

namespace perch {

// Whether a page of the profile with `profile_token` (Profile::UniqueToken())
// must stay awake: its URL matches one of the profile's never-sleep rules.
// Chromium's discard check asks this.
bool IsSleepExempt(const base::UnguessableToken& profile_token,
                   const GURL& url);

// Follows the profile's never-sleep rules, and Local State's memory saver
// timeout, from now on. Safe to call for every window.
void WatchMemorySaver(Profile* profile);

std::vector<SleepRule> GetSleepRules(Profile* profile);
void SetSleepRules(Profile* profile, const std::vector<SleepRule>& rules);

// Minutes a background tab waits before it sleeps; 0 when memory saver is off.
int GetSleepTimeoutMinutes();
void SetSleepTimeoutMinutes(int minutes);
// The BuiltInExtensions policy sets the memory saver; its setting is locked.
bool IsMemorySaverManaged();

// Puts `tab` to sleep now, unless it is still loading. An active tab hands
// focus to its neighbour first.
void SleepTab(tabs::TabInterface* tab);

// Adds a rule that keeps the site of `url` (its domain) awake.
void NeverSleepSite(Profile* profile, const GURL& url);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEP_CONTROLLER_H_
