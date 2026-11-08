// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_MENU_MAC_H_
#define CHROME_BROWSER_PERCH_PERCH_MENU_MAC_H_

namespace perch {

// Adds Perch's items to the Mac main menu once: View → Hide Browser Chrome
// (⇧⌘\), dispatching Perch's command id like Chromium's own items, and ⌃⌘N
// for Tab → Add Tab to New Split View.
void AddPerchMenuItems();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_MENU_MAC_H_
