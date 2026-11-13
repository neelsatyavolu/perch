// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#import "chrome/browser/perch/perch_menu_mac.h"

#import <AppKit/AppKit.h>

#include <initializer_list>

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
  // Tab → Spaces ›: next, previous, new, and Space 1–9 on ⌃1…⌃9.
  NSMenu* spaces = [[NSMenu alloc] initWithTitle:@"Spaces"];
  [spaces addItem:CommandItem(@"Next Space", IDC_PERCH_SPACE_NEXT)];
  [spaces addItem:CommandItem(@"Previous Space", IDC_PERCH_SPACE_PREVIOUS)];
  [spaces addItem:CommandItem(@"New Space", IDC_PERCH_NEW_SPACE)];
  [spaces addItem:[NSMenuItem separatorItem]];
  for (int i = 0; i <= IDC_PERCH_SPACE_9 - IDC_PERCH_SPACE_1; ++i) {
    NSMenuItem* item = CommandItem(
        [NSString stringWithFormat:@"Space %d", i + 1], IDC_PERCH_SPACE_1 + i);
    item.keyEquivalent = [NSString stringWithFormat:@"%d", i + 1];
    item.keyEquivalentModifierMask = NSEventModifierFlagControl;
    [spaces addItem:item];
  }
  NSMenuItem* spaces_item = [[NSMenuItem alloc] initWithTitle:@"Spaces"
                                                       action:nil
                                                keyEquivalent:@""];
  spaces_item.submenu = spaces;
  [tab_menu insertItem:spaces_item atIndex:at + 4];
}

// Edit → Copy URL (⇧⌘C) and Copy URL as Markdown (⌥⇧⌘C), at the end.
void AddCopyUrl(NSMenu* main_menu) {
  NSMenu* edit_menu = [main_menu itemWithTag:IDC_EDIT_MENU].submenu;
  if (!edit_menu || [edit_menu itemWithTag:IDC_PERCH_COPY_URL_MARKDOWN]) {
    return;
  }
  NSMenuItem* copy = CommandItem(@"Copy URL", IDC_COPY_URL);
  copy.keyEquivalent = @"c";
  copy.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  NSMenuItem* markdown =
      CommandItem(@"Copy URL as Markdown", IDC_PERCH_COPY_URL_MARKDOWN);
  markdown.keyEquivalent = @"c";
  markdown.keyEquivalentModifierMask = NSEventModifierFlagCommand |
                                       NSEventModifierFlagShift |
                                       NSEventModifierFlagOption;
  [edit_menu addItem:[NSMenuItem separatorItem]];
  if (![edit_menu itemWithTag:IDC_COPY_URL]) {
    [edit_menu addItem:copy];
  }
  [edit_menu addItem:markdown];
}

}  // namespace

void AddPerchMenuItems() {
  NSMenu* main_menu = NSApp.mainMenu;
  AddCopyUrl(main_menu);
  // Tab → Add Tab to New Split View: ⌃⌘N (spec 5.3).
  SetKeyEquivalent(main_menu, IDC_NEW_SPLIT_TAB, @"n",
                   NSEventModifierFlagControl | NSEventModifierFlagCommand);
  AddTabTools(main_menu);
  // The app menu's Settings opens Perch's settings (IDC_OPTIONS is routed).
  if (NSMenuItem* settings = [[main_menu itemWithTag:IDC_CHROME_MENU].submenu
                                 itemWithTag:IDC_OPTIONS]) {
    settings.title = @"Settings\u2026";
  }
  NSMenu* view_menu = [main_menu itemWithTag:IDC_VIEW_MENU].submenu;
  // Google-only View items: Lens, AI mode and the search tools. Vertical tabs
  // stay (View › Vertical Tabs, also Settings › Appearance).
  for (NSInteger tag :
       {IDC_SHOW_GOOGLE_LENS_SHORTCUT, IDC_SHOW_AI_MODE_OMNIBOX_BUTTON,
        IDC_SHOW_SEARCH_TOOLS}) {
    if (NSMenuItem* item = [view_menu itemWithTag:tag]) {
      [view_menu removeItem:item];
    }
  }
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
  // View → Command Bar (⌘K), above Hide Browser Chrome.
  NSMenuItem* bar = CommandItem(@"Command Bar", IDC_PERCH_COMMAND_BAR);
  bar.keyEquivalent = @"k";
  bar.keyEquivalentModifierMask = NSEventModifierFlagCommand;
  // View → Show Perch Sidebar (⌘⇧.), next to Safari's ⌘⇧L sidebar.
  NSMenuItem* sidebar =
      CommandItem(@"Show Perch Sidebar", IDC_PERCH_TOGGLE_SIDEBAR);
  sidebar.keyEquivalent = @".";
  sidebar.keyEquivalentModifierMask =
      NSEventModifierFlagCommand | NSEventModifierFlagShift;
  [view_menu insertItem:[NSMenuItem separatorItem] atIndex:0];
  [view_menu insertItem:item atIndex:0];
  [view_menu insertItem:sidebar atIndex:0];
  [view_menu insertItem:bar atIndex:0];
}

}  // namespace perch
