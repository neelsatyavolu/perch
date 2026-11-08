// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_TAB_TOOLS_TAB_TOOLS_H_
#define CHROME_BROWSER_PERCH_TAB_TOOLS_TAB_TOOLS_H_

#include <vector>

#include "base/time/time.h"

class TabStripModel;

namespace perch {

// Tabs that show the same page (ignoring the part after #) as another tab.
// The active tab is kept, otherwise the leftmost. Pinned tabs are never
// counted or closed. Returns indices in ascending order.
std::vector<int> FindDuplicates(const TabStripModel& tabs);

// Tabs not looked at for longer than `age`, never the active or a pinned tab.
// Returns indices in ascending order.
std::vector<int> FindOlderThan(const TabStripModel& tabs,
                               base::TimeDelta age,
                               base::Time now);

// Closes the tabs at `indices` (ascending), so ⇧⌘T can bring them back.
void CloseTabs(TabStripModel& tabs, const std::vector<int>& indices);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_TAB_TOOLS_TAB_TOOLS_H_
