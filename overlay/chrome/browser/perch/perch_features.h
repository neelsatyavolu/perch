// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_FEATURES_H_
#define CHROME_BROWSER_PERCH_PERCH_FEATURES_H_

#include <vector>

#include "base/feature_list.h"

namespace perch {

// Adds Perch's feature defaults. They rank below --enable-features and
// --disable-features, so a developer can still flip any of them.
void AppendFeatureOverrides(
    std::vector<base::FeatureList::FeatureOverrideInfo>& out);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_FEATURES_H_
