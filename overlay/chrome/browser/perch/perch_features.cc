// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_features.h"

#include <functional>

#include "chrome/common/chrome_features.h"

namespace perch {

namespace {

// Features Perch turns off. Gemini in Chrome is Google's assistant; Perch has
// its own.
const base::Feature* const kDisabled[] = {
    &features::kGlic,
};

}  // namespace

void AppendFeatureOverrides(
    std::vector<base::FeatureList::FeatureOverrideInfo>& out) {
  for (const base::Feature* feature : kDisabled) {
    out.emplace_back(std::cref(*feature),
                     base::FeatureList::OVERRIDE_DISABLE_FEATURE);
  }
}

}  // namespace perch
