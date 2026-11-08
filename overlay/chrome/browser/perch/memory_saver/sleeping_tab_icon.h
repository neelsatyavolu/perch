// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEPING_TAB_ICON_H_
#define CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEPING_TAB_ICON_H_

#include "third_party/skia/include/core/SkColor.h"

namespace gfx {
class Canvas;
class Rect;
}  // namespace gfx

namespace perch {

// A sleeping tab's icon (DESIGN.md): a 12 px crescent moon in `color`,
// centred where the favicon goes. Drawn at full opacity, never dimmed.
void PaintSleepingMoon(gfx::Canvas* canvas,
                       const gfx::Rect& favicon_bounds,
                       SkColor color);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEPING_TAB_ICON_H_
