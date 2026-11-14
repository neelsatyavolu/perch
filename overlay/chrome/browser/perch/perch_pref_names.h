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
inline constexpr char kExtensionCaveatlyEnabled[] =
    "perch.extensions.caveatly.enabled";

// Appearance (ui-pages/src/api.ts Appearance). Profile prefs.
inline constexpr char kAppearanceTheme[] = "perch.appearance.theme";
inline constexpr char kAppearanceAccent[] = "perch.appearance.accent";
inline constexpr char kAppearanceMatchSystem[] =
    "perch.appearance.match_system";
inline constexpr char kAppearanceDarkTheme[] = "perch.appearance.dark_theme";
inline constexpr char kAppearanceHideChrome[] = "perch.appearance.hide_chrome";

// Whether the welcome page has been finished or skipped (onboarding/).
inline constexpr char kOnboardingFinished[] = "perch.onboarding_finished";

// Whether the tour has been finished or skipped; until then it opens at
// launch, so people who set up Perch before it existed take it too.
inline constexpr char kTourFinished[] = "perch.tour_finished";

// Local State: each profile's own picture, uploaded in Settings › Profile, as
// {profile folder name: base64 PNG (128 px square)}. Chromium only knows its
// built-in pictures, so Perch keeps these itself.
inline constexpr char kProfilePictures[] = "perch.profile_pictures";

// Never-sleep rules, [{"kind", "pattern"}] as in Lulltab (memory_saver/).
inline constexpr char kMemorySaverRules[] = "perch.memory_saver.rules";
// Local State: pinned tabs may sleep too (Chromium never sleeps them).
inline constexpr char kMemorySaverSleepPinned[] =
    "perch.memory_saver.sleep_pinned";

// Spaces (spaces/): [{id, name, tabs: [{url, title, pinned, active}]}], and
// the id of the one the window shows.
inline constexpr char kSpaces[] = "perch.spaces";
inline constexpr char kActiveSpace[] = "perch.active_space";
inline constexpr char kAppearanceRevealOnHover[] =
    "perch.appearance.reveal_on_hover";
inline constexpr char kAppearanceDensity[] = "perch.appearance.density";

// Fingerprinting protection (spec 5.1), applied in the shell's privacy work.
inline constexpr char kFingerprinting[] = "perch.fingerprinting";

}  // namespace perch::prefs

#endif  // CHROME_BROWSER_PERCH_PERCH_PREF_NAMES_H_
