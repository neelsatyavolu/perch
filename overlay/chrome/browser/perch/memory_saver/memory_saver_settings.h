// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_MEMORY_SAVER_MEMORY_SAVER_SETTINGS_H_
#define CHROME_BROWSER_PERCH_MEMORY_SAVER_MEMORY_SAVER_SETTINGS_H_

#include <string>

#include "base/types/expected.h"
#include "base/values.h"

class Profile;

namespace perch {

// Settings › Performance (ui-pages api.ts MemorySaverSettings):
// {timeoutMinutes, rules: [{kind, pattern}]}. timeoutMinutes 0 is off.
base::DictValue GetMemorySaverSettings(Profile* profile);

// Applies {timeoutMinutes?, rules?}; a field left out stays. The error is a
// sentence for the page.
base::expected<base::DictValue, std::string> SetMemorySaverSettings(
    Profile* profile,
    const base::DictValue& patch);

// Adds what the person typed, in Lulltab's forms.
base::expected<base::DictValue, std::string> AddSleepRule(
    Profile* profile,
    const std::string& input);

// Every tab of the profile's windows: [{title, url, bytes, asleep}], with the
// memory Chromium estimates for the page (0 for a sleeping tab).
base::ListValue ListTabMemory(Profile* profile);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_MEMORY_SAVER_MEMORY_SAVER_SETTINGS_H_
