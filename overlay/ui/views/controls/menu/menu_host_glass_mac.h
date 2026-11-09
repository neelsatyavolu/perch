// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef UI_VIEWS_CONTROLS_MENU_MENU_HOST_GLASS_MAC_H_
#define UI_VIEWS_CONTROLS_MENU_MENU_HOST_GLASS_MAC_H_

namespace views {

class Widget;

// Perch: puts the macOS menu material behind a views menu's window, clipped
// to `corner_radius`, so the menu reads as frosted glass over the page while
// views still draws its rows on top.
void ApplyPerchMenuGlass(Widget* menu_host, int corner_radius);

}  // namespace views

#endif  // UI_VIEWS_CONTROLS_MENU_MENU_HOST_GLASS_MAC_H_
