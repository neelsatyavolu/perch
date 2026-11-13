// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_TOOLBAR_AGENT_TABS_BUTTON_H_
#define CHROME_BROWSER_PERCH_TOOLBAR_AGENT_TABS_BUTTON_H_

#include <memory>

class BrowserWindowInterface;

namespace views {
class View;
class Widget;
}

namespace perch {

// The "Agent Tabs  N" button: shown while agents have tabs open in the hidden
// agent window (agent/agent_tabs.h). It opens a list of those tabs (picking
// one moves it into this window) and Close all. It sits at the right end of
// the tab strip; with vertical tabs, which have no strip row, in the toolbar.
enum class AgentTabsPlacement { kTabStrip, kToolbar };
std::unique_ptr<views::View> CreateAgentTabsButton(
    BrowserWindowInterface* browser,
    AgentTabsPlacement placement);

// For snapshots: opens the list from `browser`'s button, and the list's
// window while it is open.
void OpenAgentTabsMenuForSnapshot(BrowserWindowInterface* browser);
views::Widget* GetAgentTabsMenuWidget();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_TOOLBAR_AGENT_TABS_BUTTON_H_
