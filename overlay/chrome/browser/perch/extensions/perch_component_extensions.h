// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_COMPONENT_EXTENSIONS_H_
#define CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_COMPONENT_EXTENSIONS_H_

#include <string>
#include <string_view>
#include <vector>

class Profile;

namespace perch {

// The Perch extension's id (build/bundled-extensions.json).
inline constexpr char kPerchExtensionId[] = "ocjanjehckpdbcjamffmbeemoooamjpo";

// Overrides where the built-in extensions are read from (development builds).
inline constexpr char kExtensionsDirSwitch[] = "perch-extensions-dir";

// Loads the extensions Perch ships built in (Perch's own, Backrow and
// Caveatly) as component extensions: the user can turn each one off in
// Settings but cannot uninstall it. Manifests are read off the UI thread, and
// each one follows its pref while the profile lives. Called from
// ComponentLoader::AddDefaultComponentExtensions().
void AddPerchComponentExtensions(Profile* profile);

struct BuiltInExtensionState {
  std::string name;
  bool enabled;
};

// Each built-in extension and whether it is on, in a fixed order.
std::vector<BuiltInExtensionState> ListBuiltInExtensions(Profile* profile);

// Turns one on or off by name; it loads or unloads right away. Returns false
// for an unknown name.
bool SetBuiltInExtensionEnabled(Profile* profile,
                                std::string_view name,
                                bool enabled);

// Whether `id` is one of the built-in extensions, for Chromium's component
// extension allowlist.
bool IsPerchComponentExtension(std::string_view id);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_COMPONENT_EXTENSIONS_H_
