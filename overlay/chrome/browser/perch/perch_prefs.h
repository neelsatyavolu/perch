// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_PREFS_H_
#define CHROME_BROWSER_PERCH_PERCH_PREFS_H_

class PrefRegistrySimple;

namespace user_prefs {
class PrefRegistrySyncable;
}

namespace perch {

// Called at the end of Chromium's RegisterLocalState().
void RegisterLocalStatePrefs(PrefRegistrySimple* registry);

// Called at the end of Chromium's RegisterProfilePrefs().
void RegisterProfilePrefs(user_prefs::PrefRegistrySyncable* registry);

// Changes the defaults of Chromium's own prefs where Perch differs. Called
// right after RegisterProfilePrefs(), so every pref here is registered.
void OverrideChromiumDefaults(user_prefs::PrefRegistrySyncable* registry);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_PREFS_H_
