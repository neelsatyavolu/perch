// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_BUILT_IN_POLICY_H_
#define CHROME_BROWSER_PERCH_PERCH_BUILT_IN_POLICY_H_

#include <optional>
#include <string_view>

namespace perch {

// The value an administrator forced for one key of the BuiltInExtensions
// policy (enterprise/policies.json: "backrow", "memorySaver"), read from the
// managed preferences for co.xanom.perch. Null when nothing is forced. False
// turns the feature off and locks its setting.
std::optional<bool> ForcedBuiltIn(std::string_view key);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_BUILT_IN_POLICY_H_
