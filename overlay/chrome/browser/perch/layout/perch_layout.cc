// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/layout/perch_layout.h"

#include "chrome/browser/ui/layout_constants.h"

namespace perch {

std::optional<int> PerchLayoutConstant(LayoutConstant constant, bool touch_ui) {
  if (touch_ui) {
    return std::nullopt;
  }
  switch (constant) {
    // 29 + the 1 px overlap with the toolbar + 6 px padding = a 36 px strip.
    case LayoutConstant::kTabHeight:
      return 30;
    case LayoutConstant::kLocationBarHeight:
    case LayoutConstant::kToolbarButtonHeight:
      return 28;
    default:
      return std::nullopt;
  }
}

}  // namespace perch
