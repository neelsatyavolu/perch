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
#define IDC_PERCH_DOWNLOADS_MENU 46018
#define IDC_PERCH_EXTENSIONS_MENU 46019
// The command bar (command_bar/).
#define IDC_PERCH_COMMAND_BAR 46013
#define IDC_PERCH_COPY_URL_MARKDOWN 46014
// Spaces (spaces/): next, previous, new, and the first nine by position.
#define IDC_PERCH_SPACE_NEXT 46015
#define IDC_PERCH_SPACE_PREVIOUS 46016
#define IDC_PERCH_NEW_SPACE 46017
#define IDC_PERCH_SPACE_1 46020
#define IDC_PERCH_SPACE_9 46028
// Split view (spec 5.3): focus the left or right side, ⌃⌘[ and ⌃⌘].
#define IDC_PERCH_SPLIT_FOCUS_LEFT 46030
#define IDC_PERCH_SPLIT_FOCUS_RIGHT 46031
// Tab menu: open Backrow on a streaming site (extensions/watch_party.h).
#define IDC_PERCH_START_WATCH_PARTY 46032
// View → Show Perch Sidebar, ⌘⇧. (side_panel/).
#define IDC_PERCH_TOGGLE_SIDEBAR 46033
// One per profile row.
#define IDC_PERCH_PROFILE_FIRST 46100
#define IDC_PERCH_PROFILE_LAST 46149
// The profile menu's recent downloads, newest first.
#define IDC_PERCH_DOWNLOAD_FIRST 46150
#define IDC_PERCH_DOWNLOAD_LAST 46154
#define IDC_PERCH_LAST 46199

#endif  // CHROME_BROWSER_PERCH_PERCH_COMMAND_IDS_H_
