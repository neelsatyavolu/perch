// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_LAYOUT_PERCH_LAYOUT_H_
#define CHROME_BROWSER_PERCH_LAYOUT_PERCH_LAYOUT_H_

#include <optional>

#include "chrome/browser/ui/layout_constants.h"
#include "ui/gfx/geometry/insets.h"


namespace perch {

// DESIGN.md's sizes for the browser frame: a 36 px tab strip, a 40 px
// toolbar with a 28 px address bar and 28 px buttons. Returns nothing for the
// constants Perch leaves at Chromium's values. Touch UI keeps Chromium's.
std::optional<int> PerchLayoutConstant(LayoutConstant constant, bool touch_ui);

// Insets Perch sizes itself: toolbar buttons are 28px squares (DESIGN.md),
// the avatar and menu buttons included.
std::optional<gfx::Insets> PerchLayoutInsets(LayoutInset inset, bool touch_ui);

// Settings → Appearance → Density: Compact makes the tab strip 32 px and the
// toolbar controls 24 px (DESIGN.md). Windows pick it up as they lay out.
void SetCompactDensity(bool compact);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_LAYOUT_PERCH_LAYOUT_H_
