// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/memory_saver/sleeping_tab_icon.h"

#include "cc/paint/paint_flags.h"
#include "third_party/skia/include/core/SkPath.h"
#include "third_party/skia/include/pathops/SkPathOps.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/geometry/point_f.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"

namespace perch {

namespace {

constexpr float kMoonSize = 12.0f;
constexpr float kBadgeMoonSize = 7.0f;
// The badge's ring reaches this far past the badge moon on every side.
constexpr float kBadgeRing = 1.5f;

void PaintMoon(gfx::Canvas* canvas,
               float cx,
               float cy,
               float size,
               SkColor color) {
  const float radius = size / 2;
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

}  // namespace

void PaintSleepingMoon(gfx::Canvas* canvas,
                       const gfx::Rect& favicon_bounds,
                       SkColor color) {
  const gfx::RectF bounds(favicon_bounds);
  PaintMoon(canvas, bounds.CenterPoint().x(), bounds.CenterPoint().y(),
            kMoonSize, color);
}

void PaintSleepingBadge(gfx::Canvas* canvas,
                        const gfx::Rect& favicon_bounds,
                        SkColor color,
                        SkColor ring) {
  const gfx::RectF bounds(favicon_bounds);
  // The badge sits on the favicon's bottom right corner, overhanging it a
  // little, as macOS badges do.
  const float cx = bounds.right() - kBadgeMoonSize / 2 + 1.0f;
  const float cy = bounds.bottom() - kBadgeMoonSize / 2 + 1.0f;
  cc::PaintFlags ring_flags;
  ring_flags.setAntiAlias(true);
  ring_flags.setStyle(cc::PaintFlags::kFill_Style);
  ring_flags.setColor(ring);
  canvas->DrawCircle(gfx::PointF(cx, cy), kBadgeMoonSize / 2 + kBadgeRing,
                     ring_flags);
  PaintMoon(canvas, cx, cy, kBadgeMoonSize, color);
}

}  // namespace perch
