// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_COMMAND_IDS_H_
#define CHROME_BROWSER_PERCH_PERCH_COMMAND_IDS_H_

// Perch's browser commands, in a range Chromium's chrome_command_ids.h does
// not use (46000–46199).
#define IDC_PERCH_FIRST 46000
#define IDC_PERCH_TOGGLE_HIDE_CHROME 46001
#define IDC_PERCH_CLOSE_DUPLICATE_TABS 46002
#define IDC_PERCH_CLOSE_TABS_OLDER_THAN_DAY 46003
#define IDC_PERCH_CLOSE_TABS_OLDER_THAN_WEEK 46004
#define IDC_PERCH_CLOSE_TABS_OLDER_THAN_MONTH 46005
// The tab context menu's "Close Tabs Older Than" submenu.
#define IDC_PERCH_CLOSE_TABS_OLDER_THAN_MENU 46006
#define IDC_PERCH_LAST 46199

#endif  // CHROME_BROWSER_PERCH_PERCH_COMMAND_IDS_H_
