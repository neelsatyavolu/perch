// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_TOOLBAR_PERCH_EXTENSIONS_MENU_H_
#define CHROME_BROWSER_PERCH_TOOLBAR_PERCH_EXTENSIONS_MENU_H_

class BrowserWindowInterface;
class ExtensionsContainer;
class ExtensionsContainerViews;

namespace views {
class View;
}

namespace perch {

// The toolbar's extensions button opens this panel in place of Chromium's
// extensions bubble: Manage Extensions and Get Extensions, then one row per
// installed extension, by name. A row's name runs the extension; beside it
// are a pin for the toolbar and a "more" button with the extension's own
// menu. The panel is frosted like Perch's menus. Clicking the button again
// closes it. Always true: Chromium's bubble never opens.
bool ShowPerchExtensionsMenu(BrowserWindowInterface* browser,
                             views::View* anchor,
                             ExtensionsContainer* container,
                             ExtensionsContainerViews* container_views);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_TOOLBAR_PERCH_EXTENSIONS_MENU_H_
