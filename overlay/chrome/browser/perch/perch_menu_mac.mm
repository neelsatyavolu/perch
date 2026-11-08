// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#import "chrome/browser/perch/perch_menu_mac.h"

#import <AppKit/AppKit.h>

#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/perch/perch_command_ids.h"

namespace perch {

namespace {

// Gives the main menu item with `tag`, anywhere in the menu, a key equivalent.
void SetKeyEquivalent(NSMenu* menu,
                      NSInteger tag,
                      NSString* key,
                      NSEventModifierFlags modifiers) {
  for (NSMenuItem* item in menu.itemArray) {
    if (item.tag == tag && item.keyEquivalent.length == 0) {
      item.keyEquivalent = key;
      item.keyEquivalentModifierMask = modifiers;
      return;
    }
    if (item.submenu) {
      SetKeyEquivalent(item.submenu, tag, key, modifiers);
    }
  }
}

}  // namespace

void AddPerchMenuItems() {
  NSMenu* main_menu = NSApp.mainMenu;
  // Tab → Add Tab to New Split View: ⌃⌘N (spec 5.3).
  SetKeyEquivalent(main_menu, IDC_NEW_SPLIT_TAB, @"n",
                   NSEventModifierFlagControl | NSEventModifierFlagCommand);
  NSMenu* view_menu = [main_menu itemWithTag:IDC_VIEW_MENU].submenu;
  if (!view_menu || [view_menu itemWithTag:IDC_PERCH_TOGGLE_HIDE_CHROME]) {
    return;
  }
  NSMenuItem* item = [[NSMenuItem alloc]
      initWithTitle:@"Hide Browser Chrome"
             action:@selector(commandDispatch:)
      keyEquivalent:@"\\"];
  item.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  item.tag = IDC_PERCH_TOGGLE_HIDE_CHROME;
  [view_menu insertItem:[NSMenuItem separatorItem] atIndex:0];
  [view_menu insertItem:item atIndex:0];
}

}  // namespace perch
