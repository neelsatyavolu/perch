// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_ARTIFACT_NAVIGATION_THROTTLE_H_
#define CHROME_BROWSER_PERCH_AGENT_ARTIFACT_NAVIGATION_THROTTLE_H_

#include "content/public/browser/navigation_throttle.h"

namespace perch {

// The navigation lock for artifacts (plan 3b task 12): a page the agent made
// can't send itself, or the frame above it, anywhere else. Any navigation a
// perch-artifact:// page starts (script, meta refresh, a form, top.location)
// is cancelled unless it goes to another perch-artifact:// address. The
// person can still leave an artifact tab from the address bar.
class ArtifactNavigationThrottle : public content::NavigationThrottle {
 public:
  static void MaybeCreateAndAdd(content::NavigationThrottleRegistry& registry);

  explicit ArtifactNavigationThrottle(
      content::NavigationThrottleRegistry& registry);
  ~ArtifactNavigationThrottle() override;

  // content::NavigationThrottle:
  ThrottleCheckResult WillStartRequest() override;
  ThrottleCheckResult WillRedirectRequest() override;
  const char* GetNameForLogging() override;

 private:
  ThrottleCheckResult Check();
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_ARTIFACT_NAVIGATION_THROTTLE_H_
