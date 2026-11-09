// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "ui/views/controls/menu/menu_host_glass_mac.h"

#import <AppKit/AppKit.h>

#include "ui/gfx/native_ui_types.h"
#include "ui/views/widget/widget.h"

namespace views {

namespace {

// A stretchable rounded-rect mask: AppKit clips the blur to it, which a layer
// corner radius alone doesn't do for NSVisualEffectView.
NSImage* RoundedMask(CGFloat radius) {
  const CGFloat edge = radius * 2 + 1;
  NSImage* mask = [NSImage imageWithSize:NSMakeSize(edge, edge)
                                 flipped:NO
                          drawingHandler:^BOOL(NSRect rect) {
                            [NSColor.blackColor setFill];
                            [[NSBezierPath bezierPathWithRoundedRect:rect
                                                             xRadius:radius
                                                             yRadius:radius]
                                fill];
                            return YES;
                          }];
  mask.capInsets = NSEdgeInsetsMake(radius, radius, radius, radius);
  mask.resizingMode = NSImageResizingModeStretch;
  return mask;
}

}  // namespace

void ApplyPerchMenuGlass(Widget* menu_host, int corner_radius) {
  NSWindow* window = menu_host->GetNativeWindow().GetNativeNSWindow();
  NSView* content = window.contentView;
  if (!content) {
    return;
  }
  NSView* glass = nil;
  if (@available(macOS 26, *)) {
    // Liquid Glass: bends and blurs what is behind the window, and clips to
    // its own corner radius.
    NSGlassEffectView* liquid =
        [[NSGlassEffectView alloc] initWithFrame:content.bounds];
    liquid.style = NSGlassEffectViewStyleRegular;
    liquid.cornerRadius = corner_radius;
    glass = liquid;
  } else {
    NSVisualEffectView* frosted =
        [[NSVisualEffectView alloc] initWithFrame:content.bounds];
    frosted.material = NSVisualEffectMaterialMenu;
    frosted.blendingMode = NSVisualEffectBlendingModeBehindWindow;
    frosted.state = NSVisualEffectStateActive;
    if (corner_radius > 0) {
      frosted.maskImage = RoundedMask(corner_radius);
    }
    glass = frosted;
  }
  glass.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
  [content addSubview:glass positioned:NSWindowBelow relativeTo:nil];
}

}  // namespace views
