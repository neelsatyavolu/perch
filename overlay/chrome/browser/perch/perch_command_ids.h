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
#define IDC_PERCH_SLEEP_TAB 46007
#define IDC_PERCH_NEVER_SLEEP_SITE 46008
// The profile menu (toolbar/perch_profile_menu.h).
#define IDC_PERCH_NEW_PROFILE 46009
#define IDC_PERCH_MANAGE_PROFILES 46010
#define IDC_PERCH_OPEN_SETTINGS 46011
#define IDC_PERCH_DEVELOPERS_MENU 46012
// The command bar (command_bar/).
#define IDC_PERCH_COMMAND_BAR 46013
#define IDC_PERCH_COPY_URL_MARKDOWN 46014
// One per profile row.
#define IDC_PERCH_PROFILE_FIRST 46100
#define IDC_PERCH_PROFILE_LAST 46149
#define IDC_PERCH_LAST 46199

#endif  // CHROME_BROWSER_PERCH_PERCH_COMMAND_IDS_H_
