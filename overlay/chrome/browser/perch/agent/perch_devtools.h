// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_PERCH_DEVTOOLS_H_
#define CHROME_BROWSER_PERCH_AGENT_PERCH_DEVTOOLS_H_

#include "base/containers/span.h"

namespace content {
class DevToolsAgentHostClientChannel;
}

namespace perch {

// The `Perch` CDP domain, for perchd over its private pipe (a trusted client)
// only. Handles `Perch.*` commands and answers them on `channel`. Returns
// false for any other method, which then goes to Chromium's own handlers.
//
//   Perch.getInfo     -> {product, perch: true}
//   Perch.setTabGroup {targetIds, title, color?}: groups the tabs in their
//                     window, reusing a group with the same title there.
//   Perch.claimTab    {targetId}: keeps a background tab drawing and awake,
//                     so the agent can click, read and screenshot it.
//   Perch.releaseTab  {targetId}: drops that hold.
bool MaybeHandleCommand(content::DevToolsAgentHostClientChannel* channel,
                        base::span<const uint8_t> message);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_PERCH_DEVTOOLS_H_
