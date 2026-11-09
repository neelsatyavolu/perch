// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_TOOLBAR_PERCH_EXTENSIONS_MENU_H_
#define CHROME_BROWSER_PERCH_TOOLBAR_PERCH_EXTENSIONS_MENU_H_

class BrowserWindowInterface;

namespace views {
class View;
}

namespace perch {

// The toolbar's extensions button opens this list in place of Chromium's
// extensions bubble: Manage Extensions and the Chrome Web Store, then each
// installed extension with its icon. An extension's submenu opens it, pins
// or unpins it in the toolbar, and opens its options. True once it is open.
bool ShowPerchExtensionsMenu(BrowserWindowInterface* browser,
                             views::View* anchor);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_TOOLBAR_PERCH_EXTENSIONS_MENU_H_
