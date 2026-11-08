// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/artifact_navigation_throttle.h"

#include <memory>

#include "chrome/browser/perch/agent/artifact_scheme.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/navigation_throttle_registry.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "url/origin.h"

namespace perch {

namespace {

bool IsArtifact(const url::Origin& origin) {
  // Artifacts have opaque origins (a no-access scheme); look at the precursor.
  return origin.GetTupleOrPrecursorTupleIfOpaque().scheme() == kArtifactScheme;
}

}  // namespace

// static
void ArtifactNavigationThrottle::MaybeCreateAndAdd(
    content::NavigationThrottleRegistry& registry) {
  registry.AddThrottle(std::make_unique<ArtifactNavigationThrottle>(registry));
}

ArtifactNavigationThrottle::ArtifactNavigationThrottle(
    content::NavigationThrottleRegistry& registry)
    : content::NavigationThrottle(registry) {}

ArtifactNavigationThrottle::~ArtifactNavigationThrottle() = default;

content::NavigationThrottle::ThrottleCheckResult
ArtifactNavigationThrottle::WillStartRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult
ArtifactNavigationThrottle::WillRedirectRequest() {
  return Check();
}

content::NavigationThrottle::ThrottleCheckResult
ArtifactNavigationThrottle::Check() {
  content::NavigationHandle* handle = navigation_handle();
  if (handle->GetURL().SchemeIs(kArtifactScheme) ||
      !handle->IsRendererInitiated()) {
    return PROCEED;
  }
  bool from_artifact = handle->GetInitiatorOrigin() &&
                       IsArtifact(*handle->GetInitiatorOrigin());
  if (!from_artifact) {
    // The frame being navigated shows an artifact (a meta refresh, or a
    // navigation an artifact frame started on itself).
    if (content::RenderFrameHost* frame =
            handle->GetWebContents()->UnsafeFindFrameByFrameTreeNodeId(
                handle->GetFrameTreeNodeId())) {
      from_artifact = frame->GetLastCommittedURL().SchemeIs(kArtifactScheme);
    }
  }
  return from_artifact ? CANCEL : PROCEED;
}

const char* ArtifactNavigationThrottle::GetNameForLogging() {
  return "PerchArtifactNavigationThrottle";
}

}  // namespace perch
