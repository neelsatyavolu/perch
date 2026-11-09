// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SPACES_SPACES_H_
#define CHROME_BROWSER_PERCH_SPACES_SPACES_H_

#include <memory>
#include <string>
#include <vector>

#include "url/gurl.h"

class BrowserWindowInterface;
class Profile;

namespace views {
class View;
}

namespace perch {

// A tab kept in a space while another space shows.
struct SpaceTab {
  GURL url;
  std::u16string title;
  bool pinned = false;
  bool active = false;
};

struct SpaceInfo {
  std::string id;
  std::u16string name;
  bool active = false;
};

// Spaces (spec 5.9): named sets of tabs, one shown per window at a time, and
// each shown in at most one window. A
// space's tabs live in the profile's perch.spaces pref while it is hidden,
// and come back unloaded (asleep) except the one that was active. Tab groups
// are flattened. There is always at least one space.
std::vector<SpaceInfo> ListSpaces(BrowserWindowInterface* browser);
std::u16string ActiveSpaceName(BrowserWindowInterface* browser);

void SwitchToSpace(BrowserWindowInterface* browser, size_t index);
void SwitchSpaceBy(BrowserWindowInterface* browser, int delta);
// Adds "Space N" after the others and switches to it.
void NewSpace(BrowserWindowInterface* browser);
void RenameActiveSpace(BrowserWindowInterface* browser,
                       const std::u16string& name);
// Moves the active space's tabs into the space before it (never closes
// them) and removes it. Does nothing to the last space left.
void DeleteActiveSpace(BrowserWindowInterface* browser);

// Adds tabs at the end of the window without loading them; the one marked
// active loads and is selected. Import (plan 3b) uses this too.
void OpenTabsAsleep(BrowserWindowInterface* browser,
                    const std::vector<SpaceTab>& tabs);
// The same, but no tab is selected: the tab in use stays in use.
void AppendTabsAsleep(BrowserWindowInterface* browser,
                      const std::vector<SpaceTab>& tabs);

// The button at the tab strip's leading edge: the space's name and a menu.
std::unique_ptr<views::View> CreateSpacesButton(BrowserWindowInterface* browser);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SPACES_SPACES_H_
