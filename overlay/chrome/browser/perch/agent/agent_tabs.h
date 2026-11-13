// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_AGENT_TABS_H_
#define CHROME_BROWSER_PERCH_AGENT_AGENT_TABS_H_

#include <vector>

#include "base/observer_list_types.h"

class BrowserWindowInterface;
class GURL;
class Profile;

namespace content {
class WebContents;
}

namespace tabs {
class TabInterface;
}

namespace perch {

// Agent tabs: the tabs agents open for their work live in one hidden window
// per profile, never in the user's tab strip. The window is never shown and
// never restored after a restart; Perch keeps its tabs drawing (claimTab), so
// agents can read and click them. The toolbar's Agent Tabs button lists them;
// picking one moves it into the user's window.

class AgentTabsObserver : public base::CheckedObserver {
 public:
  // An agent tab opened, closed, loaded or was moved out.
  virtual void OnAgentTabsChanged() = 0;
};

void AddAgentTabsObserver(AgentTabsObserver* observer);
void RemoveAgentTabsObserver(AgentTabsObserver* observer);

// Opens `url` in a new tab of the profile's agent window, making the window
// if needed. Null when no window can be made (the profile is shutting down).
content::WebContents* OpenAgentTab(Profile* profile, const GURL& url);

// Whether `browser` is an agent window. While one is being made (its window
// features initialise inside the creation call), this is true for it too.
bool IsAgentWindow(const BrowserWindowInterface* browser);
bool IsCreatingAgentWindow();

// The profile's agent tabs, oldest first.
std::vector<tabs::TabInterface*> AgentTabsFor(Profile* profile);

// Moves an agent tab into `into`, after its last tab, and selects it.
void ShowAgentTab(tabs::TabInterface* tab, BrowserWindowInterface* into);

// Closes all of the profile's agent tabs (and with them its agent window).
void CloseAgentTabs(Profile* profile);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_AGENT_TABS_H_
