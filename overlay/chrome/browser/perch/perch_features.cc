// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_features.h"

#include <functional>

#include "chrome/common/chrome_features.h"
#include "components/network_time/network_time_tracker.h"
#include "components/omnibox/browser/aim_eligibility_service_features.h"
#include "components/omnibox/common/omnibox_features.h"
#include "components/optimization_guide/core/optimization_guide_features.h"
#include "components/safe_browsing/core/common/features.h"
#include "extensions/common/extension_features.h"
#include "services/network/public/cpp/features.h"
#include "third_party/blink/public/common/features.h"

namespace perch {

namespace {

// Features Perch turns on. Sites see only the user's main language, and a
// playing video moves into picture in picture when its tab is hidden.
const base::Feature* const kEnabled[] = {
    &network::features::kReduceAcceptLanguage,
    &blink::features::kBrowserInitiatedAutomaticPictureInPicture,
};

// Features Perch turns off (spec 5.1): Gemini in Chrome and Google's AI mode
// with its eligibility checks and extensions (Perch has its own agent),
// optimization hints from Google, real-time Safe Browsing lookups (the
// downloaded lists stay), and Google's network time queries.
const base::Feature* const kDisabled[] = {
    &features::kGlic,
    &omnibox::kAimServerEligibilityEnabled,
    &omnibox::kAimServerRequestOnStartupEnabled,
    &omnibox::kAimEligibilityComponentExtension,
    &extensions_features::kApiContextualTasksPrivate,
    &optimization_guide::features::kOptimizationHints,
    &safe_browsing::kHashPrefixRealTimeLookups,
    &network_time::kNetworkTimeServiceQuerying,
};

}  // namespace

void AppendFeatureOverrides(
    std::vector<base::FeatureList::FeatureOverrideInfo>& out) {
  for (const base::Feature* feature : kEnabled) {
    out.emplace_back(std::cref(*feature),
                     base::FeatureList::OVERRIDE_ENABLE_FEATURE);
  }
  for (const base::Feature* feature : kDisabled) {
    out.emplace_back(std::cref(*feature),
                     base::FeatureList::OVERRIDE_DISABLE_FEATURE);
  }
}

}  // namespace perch
