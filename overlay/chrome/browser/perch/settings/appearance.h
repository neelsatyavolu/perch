// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SETTINGS_APPEARANCE_H_
#define CHROME_BROWSER_PERCH_SETTINGS_APPEARANCE_H_

#include <optional>
#include <string>

#include "base/values.h"

class PrefService;

namespace perch {

// The Appearance object of ui-pages/src/api.ts, from the profile's prefs.
base::DictValue GetAppearance(const PrefService& prefs);

// Applies a partial Appearance. Returns an error message, and changes nothing,
// when any field is unknown or has a bad value.
std::optional<std::string> SetAppearance(PrefService& prefs,
                                         const base::DictValue& patch);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SETTINGS_APPEARANCE_H_
