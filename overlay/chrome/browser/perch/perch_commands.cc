// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_commands.h"

#include "chrome/browser/command_updater.h"
#include "chrome/browser/perch/hide_chrome/hide_chrome.h"
#include "chrome/browser/perch/perch_command_ids.h"

namespace perch {

static_assert(IDC_PERCH_FIRST == 46000 && IDC_PERCH_LAST == 46199,
              "Perch's command range; chrome_command_ids.h has no 460xx ids");

void EnablePerchCommands(CommandUpdater* updater) {
  updater->UpdateCommandEnabled(IDC_PERCH_TOGGLE_HIDE_CHROME, true);
}

bool ExecutePerchCommand(BrowserWindowInterface* browser, int id) {
  switch (id) {
    case IDC_PERCH_TOGGLE_HIDE_CHROME:
      ToggleHideChrome(browser);
      return true;
    default:
      return false;
  }
}

}  // namespace perch
