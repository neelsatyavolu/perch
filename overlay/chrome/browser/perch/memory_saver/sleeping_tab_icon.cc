// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/memory_saver/sleeping_tab_icon.h"

#include "cc/paint/paint_flags.h"
#include "third_party/skia/include/core/SkPath.h"
#include "third_party/skia/include/pathops/SkPathOps.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"

namespace perch {

namespace {

constexpr float kMoonSize = 12.0f;

}  // namespace

void PaintSleepingMoon(gfx::Canvas* canvas,
                       const gfx::Rect& favicon_bounds,
                       SkColor color) {
  const gfx::RectF bounds(favicon_bounds);
  const float radius = kMoonSize / 2;
  const float cx = bounds.CenterPoint().x();
  const float cy = bounds.CenterPoint().y();
  // A full disc with a smaller disc cut from its upper right.
  const SkPath disc = SkPath::Circle(cx, cy, radius);
  const SkPath bite =
      SkPath::Circle(cx + radius * 0.45f, cy - radius * 0.35f, radius * 0.8f);
  SkPath moon;
  if (!Op(disc, bite, kDifference_SkPathOp, &moon)) {
    moon = disc;
  }
  cc::PaintFlags flags;
  flags.setAntiAlias(true);
  flags.setStyle(cc::PaintFlags::kFill_Style);
  flags.setColor(color);
  canvas->DrawPath(moon, flags);
}

}  // namespace perch
