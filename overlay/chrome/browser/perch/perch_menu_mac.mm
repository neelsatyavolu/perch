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

NSMenuItem* CommandItem(NSString* title, int tag) {
  NSMenuItem* item = [[NSMenuItem alloc] initWithTitle:title
                                                action:@selector(commandDispatch:)
                                         keyEquivalent:@""];
  item.tag = tag;
  return item;
}

// Tab → Close Duplicate Tabs, and Close Tabs Older Than › a day, week, month,
// after Close Other Tabs.
void AddTabTools(NSMenu* main_menu) {
  NSMenu* tab_menu = [main_menu itemWithTag:IDC_TAB_MENU].submenu;
  if (!tab_menu || [tab_menu itemWithTag:IDC_PERCH_CLOSE_DUPLICATE_TABS]) {
    return;
  }
  NSMenu* older = [[NSMenu alloc] initWithTitle:@"Close Tabs Older Than"];
  [older addItem:CommandItem(@"1 Day", IDC_PERCH_CLOSE_TABS_OLDER_THAN_DAY)];
  [older addItem:CommandItem(@"1 Week", IDC_PERCH_CLOSE_TABS_OLDER_THAN_WEEK)];
  [older addItem:CommandItem(@"1 Month", IDC_PERCH_CLOSE_TABS_OLDER_THAN_MONTH)];
  NSMenuItem* older_item = [[NSMenuItem alloc] initWithTitle:older.title
                                                      action:nil
                                               keyEquivalent:@""];
  older_item.submenu = older;
  NSInteger at = [tab_menu indexOfItemWithTag:IDC_WINDOW_CLOSE_OTHER_TABS];
  at = at < 0 ? tab_menu.numberOfItems : at + 1;
  [tab_menu insertItem:CommandItem(@"Close Duplicate Tabs",
                                   IDC_PERCH_CLOSE_DUPLICATE_TABS)
               atIndex:at];
  [tab_menu insertItem:older_item atIndex:at + 1];
  // Sleep Tab (⌥⇧S) and Never Sleep This Site, after them.
  NSMenuItem* sleep = CommandItem(@"Sleep Tab", IDC_PERCH_SLEEP_TAB);
  sleep.keyEquivalent = @"s";
  sleep.keyEquivalentModifierMask =
      NSEventModifierFlagOption | NSEventModifierFlagShift;
  [tab_menu insertItem:sleep atIndex:at + 2];
  [tab_menu insertItem:CommandItem(@"Never Sleep This Site",
                                   IDC_PERCH_NEVER_SLEEP_SITE)
               atIndex:at + 3];
}

}  // namespace

void AddPerchMenuItems() {
  NSMenu* main_menu = NSApp.mainMenu;
  // Tab → Add Tab to New Split View: ⌃⌘N (spec 5.3).
  SetKeyEquivalent(main_menu, IDC_NEW_SPLIT_TAB, @"n",
                   NSEventModifierFlagControl | NSEventModifierFlagCommand);
  AddTabTools(main_menu);
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
