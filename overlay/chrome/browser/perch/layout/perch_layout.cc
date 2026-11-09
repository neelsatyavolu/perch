// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/layout/perch_layout.h"

#include "chrome/browser/ui/layout_constants.h"

namespace perch {

namespace {
bool g_compact = false;
}  // namespace

void SetCompactDensity(bool compact) {
  g_compact = compact;
}

std::optional<int> PerchLayoutConstant(LayoutConstant constant, bool touch_ui) {
  if (touch_ui) {
    return std::nullopt;
  }
  switch (constant) {
    // 29 + the 1 px overlap with the toolbar + 6 px padding = a 36 px strip
    // (32 px when compact).
    case LayoutConstant::kTabHeight:
      return g_compact ? 26 : 30;
    case LayoutConstant::kLocationBarHeight:
    case LayoutConstant::kToolbarButtonHeight:
      return g_compact ? 24 : 28;
    // No rules between toolbar buttons, so no room for them either.
    case LayoutConstant::kToolbarDividerSpacing:
    case LayoutConstant::kToolbarDividerWidth:
      return 0;
    // Chips inside the 8px address bar.
    case LayoutConstant::kLocationBarChildCornerRadius:
      return 6;
    default:
      return std::nullopt;
  }
}

std::optional<gfx::Insets> PerchLayoutInsets(LayoutInset inset,
                                             bool touch_ui) {
  if (touch_ui) {
    return std::nullopt;
  }
  switch (inset) {
    case TOOLBAR_BUTTON:
      return gfx::Insets(g_compact ? 2 : 4);
    case BROWSER_APP_MENU_CHIP_PADDING:
      return g_compact ? gfx::Insets::TLBR(2, 4, 2, 6)
                       : gfx::Insets::TLBR(4, 4, 4, 6);
    default:
      return std::nullopt;
  }
}

}  // namespace perch
