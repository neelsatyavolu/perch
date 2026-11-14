// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_EXTENSION_UPDATES_H_
#define CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_EXTENSION_UPDATES_H_

#include <optional>
#include <string>
#include <string_view>

#include "base/files/file_path.h"

namespace perch {

// Perch's built-in extensions that live in their own repositories (Caveatly,
// Backrow) update from their GitHub releases between Perch releases. About
// once a day, while "Built-in extension updates" is allowed (Settings,
// Privacy), Perch asks GitHub for each one's latest release. It takes a
// release only when:
//   - its version is newer than the copy Perch runs, and not below the
//     version updates may start from;
//   - the zip's Ed25519 signature (the release's <asset>.sig) verifies
//     against the public key built into Perch; and
//   - the manifest inside names the same version as the release.
// The verified copy, with Perch's own manifest changes (its id key, its
// embedding switches, its ad-rule lists off), waits in
// <user data>/Perch Extensions/updates/<name> and is used from the next
// launch. What updates, from where, and the public key come from
// updates.json beside the bundled extensions (perch-build stage-extensions).

// Starts the daily checks once per browser run. Safe to call repeatedly.
void StartExtensionUpdates();

// The verified update for `name` when it is newer than `bundled_version`;
// nullopt when there is none. Runs on the extension file task runner.
std::optional<base::FilePath> NewerUpdateFor(std::string_view name,
                                             const std::string& bundled_version);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_EXTENSIONS_PERCH_EXTENSION_UPDATES_H_
