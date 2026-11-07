// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_PREF_NAMES_H_
#define CHROME_BROWSER_PERCH_PERCH_PREF_NAMES_H_

// Perch's own preferences. Only Perch files and the few Chromium files a patch
// touches include this; Chromium's pref_names.h is never edited.
namespace perch::prefs {

// Whether each built-in extension is on (profile prefs, default on).
inline constexpr char kExtensionPerchEnabled[] = "perch.extensions.perch.enabled";
inline constexpr char kExtensionBackrowEnabled[] =
    "perch.extensions.backrow.enabled";
inline constexpr char kExtensionLulltabEnabled[] =
    "perch.extensions.lulltab.enabled";
inline constexpr char kExtensionCaveatlyEnabled[] =
    "perch.extensions.caveatly.enabled";

}  // namespace perch::prefs

#endif  // CHROME_BROWSER_PERCH_PERCH_PREF_NAMES_H_
