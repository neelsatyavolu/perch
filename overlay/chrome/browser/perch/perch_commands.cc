// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_commands.h"

#include "base/time/time.h"
#include "chrome/browser/command_updater.h"
#include "chrome/browser/perch/hide_chrome/hide_chrome.h"
#include "chrome/browser/perch/perch_command_ids.h"
#include "chrome/browser/perch/tab_tools/tab_tools.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"

namespace perch {

namespace {

void CloseTabsOlderThan(BrowserWindowInterface* browser, base::TimeDelta age) {
  TabStripModel& tabs = *browser->GetTabStripModel();
  CloseTabs(tabs, FindOlderThan(tabs, age, base::Time::Now()));
}

}  // namespace

static_assert(IDC_PERCH_FIRST == 46000 && IDC_PERCH_LAST == 46199,
              "Perch's command range; chrome_command_ids.h has no 460xx ids");

void EnablePerchCommands(CommandUpdater* updater) {
  for (int id : {IDC_PERCH_TOGGLE_HIDE_CHROME, IDC_PERCH_CLOSE_DUPLICATE_TABS,
                 IDC_PERCH_CLOSE_TABS_OLDER_THAN_DAY,
                 IDC_PERCH_CLOSE_TABS_OLDER_THAN_WEEK,
                 IDC_PERCH_CLOSE_TABS_OLDER_THAN_MONTH}) {
    updater->UpdateCommandEnabled(id, true);
  }
}

bool ExecutePerchCommand(BrowserWindowInterface* browser, int id) {
  switch (id) {
    case IDC_PERCH_TOGGLE_HIDE_CHROME:
      ToggleHideChrome(browser);
      return true;
    case IDC_PERCH_CLOSE_DUPLICATE_TABS: {
      TabStripModel& tabs = *browser->GetTabStripModel();
      CloseTabs(tabs, FindDuplicates(tabs));
      return true;
    }
    case IDC_PERCH_CLOSE_TABS_OLDER_THAN_DAY:
      CloseTabsOlderThan(browser, base::Days(1));
      return true;
    case IDC_PERCH_CLOSE_TABS_OLDER_THAN_WEEK:
      CloseTabsOlderThan(browser, base::Days(7));
      return true;
    case IDC_PERCH_CLOSE_TABS_OLDER_THAN_MONTH:
      CloseTabsOlderThan(browser, base::Days(30));
      return true;
    default:
      return false;
  }
}

}  // namespace perch
