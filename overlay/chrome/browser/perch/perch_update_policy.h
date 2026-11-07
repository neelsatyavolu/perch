// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_UPDATE_POLICY_H_
#define CHROME_BROWSER_PERCH_PERCH_UPDATE_POLICY_H_

#include <optional>
#include <string>

#include "base/time/time.h"

namespace perch {

// Update control by policy (enterprise plan, task 9). Only values an MDM
// profile forces count.
struct UpdatePolicy {
  bool auto_update = true;
  std::string channel = "stable";
  int delay_days = 0;
  std::optional<std::string> minimum_version;
};

// Reads co.xanom.perch's forced AutoUpdateEnabled, UpdateChannel,
// UpdateDelayDays and MinimumVersion. A value of the wrong type is ignored.
UpdatePolicy ReadUpdatePolicy();

// Whether an update published at `published` on `channel` ("" is stable) may
// be offered now.
bool ShouldOffer(const UpdatePolicy& policy,
                 base::Time published,
                 const std::string& channel,
                 base::Time now);

// Whether `running` is older than the policy's minimum version, so Perch must
// update whatever the other settings say (unless updates are off).
bool BelowMinimumVersion(const UpdatePolicy& policy,
                         const std::string& running);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_UPDATE_POLICY_H_
