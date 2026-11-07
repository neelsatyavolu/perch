// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_COMPONENT_EXTENSIONS_H_
#define CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_COMPONENT_EXTENSIONS_H_

#include <string_view>

class Profile;

namespace perch {

// Overrides where the built-in extensions are read from (development builds).
inline constexpr char kExtensionsDirSwitch[] = "perch-extensions-dir";

// Loads the extensions Perch ships built in (Perch's own, Backrow, Lulltab and
// Caveatly) as component extensions: the user can turn each one off in
// Settings but cannot uninstall it. Manifests are read off the UI thread, and
// each one follows its pref while the profile lives. Called from
// ComponentLoader::AddDefaultComponentExtensions().
void AddPerchComponentExtensions(Profile* profile);

// Whether `id` is one of the built-in extensions, for Chromium's component
// extension allowlist.
bool IsPerchComponentExtension(std::string_view id);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_COMPONENT_EXTENSIONS_H_
