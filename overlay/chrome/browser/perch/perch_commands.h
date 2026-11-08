// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PERCH_COMMANDS_H_
#define CHROME_BROWSER_PERCH_PERCH_COMMANDS_H_

class BrowserWindowInterface;
class CommandUpdater;

namespace tabs {
class TabInterface;
}

namespace perch {

// Turns Perch's commands on in a window's command updater, so menus and
// shortcuts that name them work. Called from BrowserCommandController.
void EnablePerchCommands(CommandUpdater* updater);

// Runs one of Perch's commands. Returns false for any other id.
bool ExecutePerchCommand(BrowserWindowInterface* browser, int id);

// Runs one of Perch's commands from a tab's context menu: the tab commands
// act on `tab` instead of the active tab.
bool ExecutePerchTabCommand(tabs::TabInterface* tab, int id);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_COMMANDS_H_
