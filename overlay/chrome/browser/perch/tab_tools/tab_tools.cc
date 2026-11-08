// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/tab_tools/tab_tools.h"

#include <map>

#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace perch {

namespace {

GURL PageOf(content::WebContents* contents) {
  GURL url = contents->GetLastCommittedURL();
  if (url.is_empty()) {
    url = contents->GetVisibleURL();
  }
  return url.GetWithoutRef();
}

}  // namespace

std::vector<int> FindDuplicates(const TabStripModel& tabs) {
  // Page → the tab that stays.
  std::map<GURL, int> kept;
  for (int i = 0; i < tabs.count(); ++i) {
    if (tabs.IsTabPinned(i)) {
      continue;
    }
    const GURL page = PageOf(tabs.GetWebContentsAt(i));
    auto [it, inserted] = kept.emplace(page, i);
    if (!inserted && i == tabs.active_index()) {
      it->second = i;
    }
  }
  std::vector<int> duplicates;
  for (int i = 0; i < tabs.count(); ++i) {
    if (tabs.IsTabPinned(i)) {
      continue;
    }
    if (kept.at(PageOf(tabs.GetWebContentsAt(i))) != i) {
      duplicates.push_back(i);
    }
  }
  return duplicates;
}

std::vector<int> FindOlderThan(const TabStripModel& tabs,
                               base::TimeDelta age,
                               base::Time now) {
  std::vector<int> old;
  for (int i = 0; i < tabs.count(); ++i) {
    if (i == tabs.active_index() || tabs.IsTabPinned(i)) {
      continue;
    }
    if (now - tabs.GetWebContentsAt(i)->GetLastActiveTime() > age) {
      old.push_back(i);
    }
  }
  return old;
}

void CloseTabs(TabStripModel& tabs, const std::vector<int>& indices) {
  // From the right, so the indices still to close stay put.
  for (auto it = indices.rbegin(); it != indices.rend(); ++it) {
    tabs.CloseWebContentsAt(*it, TabCloseTypes::CLOSE_USER_GESTURE |
                                     TabCloseTypes::CLOSE_CREATE_HISTORICAL_TAB);
  }
}

}  // namespace perch
