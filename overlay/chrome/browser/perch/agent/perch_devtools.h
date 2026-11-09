// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_PERCH_DEVTOOLS_H_
#define CHROME_BROWSER_PERCH_AGENT_PERCH_DEVTOOLS_H_

#include <string_view>

#include "base/containers/span.h"
#include "base/values.h"

namespace content {
class DevToolsAgentHostClientChannel;
class WebContents;
}

namespace tabs {
class TabInterface;
}

namespace perch {

// The `Perch` CDP domain, for perchd over its private pipe (a trusted client)
// only. Handles `Perch.*` commands and answers them on `channel`. Returns
// false for any other method, which then goes to Chromium's own handlers.
//
//   Perch.getInfo     -> {product, perch: true}
//   Perch.setTabGroup {targetIds, title, color?}: groups the tabs in their
//                     window, reusing a group with the same title there.
//   Perch.claimTab    {targetId, owner?, render?}: marks the tab as the
//                     agent's and, unless render is false, keeps it drawing
//                     and awake so the agent can click, read and screenshot it.
//   Perch.releaseTab  {targetId}: drops that claim.
//   Perch.getTabs     -> {tabs: [TabInfo]} for every window and profile.
// Events: tabCreated, tabClosed {tabId}, tabMoved, tabUpdated, tabClaimed and
// tabReleased, each with a TabInfo: {tabId, targetId, windowId, profile,
// incognito, title, url, pinned, active, owner?}.
bool MaybeHandleCommand(content::DevToolsAgentHostClientChannel* channel,
                        base::span<const uint8_t> message);

// Sends `Perch.<method>` to perchd, if it is connected.
void EmitPerchEvent(std::string_view method, base::DictValue params);
bool IsPerchdConnected();

// The TabInfo sent with getTabs and the tab events.
base::DictValue TabInfo(tabs::TabInterface* tab);

// Whether the agent holds `contents` (Perch.claimTab). The memory saver never
// puts such a tab to sleep.
bool IsClaimedByAgent(const content::WebContents* contents);

// perchd's pipe closed: forget its channel, drop tab holds and clear dots.
void OnPerchdDisconnected();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_PERCH_DEVTOOLS_H_
