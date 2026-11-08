// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_commands.h"

#include "base/time/time.h"
#include "chrome/browser/command_updater.h"
#include "chrome/browser/perch/command_bar/command_bar.h"
#include "chrome/browser/perch/hide_chrome/hide_chrome.h"
#include "chrome/browser/perch/memory_saver/sleep_controller.h"
#include "chrome/browser/perch/perch_command_ids.h"
#include "chrome/browser/perch/tab_tools/tab_tools.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/page_navigator.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"
#include "content/public/browser/web_contents.h"

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
                 IDC_PERCH_CLOSE_TABS_OLDER_THAN_MONTH, IDC_PERCH_SLEEP_TAB,
                 IDC_PERCH_NEVER_SLEEP_SITE, IDC_PERCH_OPEN_SETTINGS,
                 IDC_PERCH_COMMAND_BAR, IDC_PERCH_COPY_URL_MARKDOWN}) {
    updater->UpdateCommandEnabled(id, true);
  }
}

bool ExecutePerchTabCommand(tabs::TabInterface* tab, int id) {
  if (!tab) {
    return false;
  }
  switch (id) {
    case IDC_PERCH_SLEEP_TAB:
      SleepTab(tab);
      return true;
    case IDC_PERCH_NEVER_SLEEP_SITE:
      NeverSleepSite(tab->GetBrowserWindowInterface()->GetProfile(),
                     tab->GetContents()->GetLastCommittedURL());
      return true;
    default:
      return ExecutePerchCommand(tab->GetBrowserWindowInterface(), id);
  }
}

bool ExecutePerchCommand(BrowserWindowInterface* browser, int id) {
  switch (id) {
    case IDC_PERCH_SLEEP_TAB:
    case IDC_PERCH_NEVER_SLEEP_SITE: {
      tabs::TabInterface* tab =
          browser->GetTabStripModel()->GetActiveTab();
      return tab && ExecutePerchTabCommand(tab, id);
    }
    case IDC_PERCH_TOGGLE_HIDE_CHROME:
      ToggleHideChrome(browser);
      return true;
    case IDC_PERCH_OPEN_SETTINGS:
      // Perch's settings; Chromium's stay at chrome://settings.
      browser->OpenURL(
          content::OpenURLParams(GURL("chrome://perch-settings/"),
                                 content::Referrer(),
                                 WindowOpenDisposition::kNewForegroundTab,
                                 ui::PAGE_TRANSITION_AUTO_BOOKMARK, false),
          {});
      return true;
    case IDC_PERCH_COMMAND_BAR:
      ToggleCommandBar(browser);
      return true;
    case IDC_PERCH_COPY_URL_MARKDOWN:
      CopyUrlAsMarkdown(browser);
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
