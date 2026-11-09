// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef UI_VIEWS_CONTROLS_MENU_MENU_HOST_GLASS_MAC_H_
#define UI_VIEWS_CONTROLS_MENU_MENU_HOST_GLASS_MAC_H_

#include "ui/views/views_export.h"

namespace views {

class Widget;

// Perch: puts the macOS menu material behind a views menu's or panel's window, clipped
// to `corner_radius`, so the menu reads as frosted glass over the page while
// views still draws its rows on top.
VIEWS_EXPORT void ApplyPerchMenuGlass(Widget* menu_host, int corner_radius);

}  // namespace views

#endif  // UI_VIEWS_CONTROLS_MENU_MENU_HOST_GLASS_MAC_H_
