// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

// Perch's Dock tile plug-in. The Dock loads it for Perch's tile while Perch is
// in the Dock, so the icon picked in Settings › Appearance shows while Perch
// is closed and while it starts, not only once a window is up. The browser
// saves the pick under PerchDockIcon in its defaults and posts
// co.xanom.perch.DockIconChanged (theme/perch_fonts_mac.mm).

#import <AppKit/AppKit.h>

static NSString* const kDockIconKey = @"PerchDockIcon";
static NSString* const kDockIconChanged = @"co.xanom.perch.DockIconChanged";

@interface PerchDockTilePlugIn : NSObject <NSDockTilePlugIn>
@property(nonatomic, strong) NSDockTile* tile;
@end

@implementation PerchDockTilePlugIn

// Perch.app, three levels above Contents/PlugIns/PerchDockTile.docktileplugin.
- (NSURL*)appURL {
  NSURL* plugin = [NSBundle bundleForClass:self.class].bundleURL;
  return plugin.URLByDeletingLastPathComponent.URLByDeletingLastPathComponent
      .URLByDeletingLastPathComponent;
}

// Only the plain names of the pictures Perch ships, never a path.
static BOOL IsPlainName(NSString* name) {
  if (name.length == 0) {
    return NO;
  }
  NSCharacterSet* allowed = [NSCharacterSet
      characterSetWithCharactersInString:@"abcdefghijklmnopqrstuvwxyz"];
  return [name stringByTrimmingCharactersInSet:allowed].length == 0;
}

- (NSImage*)savedIcon {
  NSURL* app = [self appURL];
  NSString* bundleID = [NSBundle bundleWithURL:app].bundleIdentifier;
  if (!bundleID) {
    return nil;
  }
  NSUserDefaults* defaults = [[NSUserDefaults alloc] initWithSuiteName:bundleID];
  NSString* name = [defaults stringForKey:kDockIconKey];
  if (!IsPlainName(name)) {
    return nil;
  }
  NSString* file = [NSString stringWithFormat:@"app-%@.png", name];
  NSURL* frameworks = [app URLByAppendingPathComponent:@"Contents/Frameworks"];
  for (NSURL* framework in [NSFileManager.defaultManager
           contentsOfDirectoryAtURL:frameworks
         includingPropertiesForKeys:nil
                            options:NSDirectoryEnumerationSkipsHiddenFiles
                              error:nil]) {
    NSURL* png = [[framework
        URLByAppendingPathComponent:@"Resources/perch_pages/app-icons"]
        URLByAppendingPathComponent:file];
    NSImage* image = [[NSImage alloc] initWithContentsOfURL:png];
    if (image) {
      return image;
    }
  }
  return nil;
}

- (void)update {
  NSImage* image = [self savedIcon];
  if (image) {
    NSImageView* view = [NSImageView imageViewWithImage:image];
    view.imageScaling = NSImageScaleProportionallyUpOrDown;
    self.tile.contentView = view;
  } else {
    // Perch's own icon.
    self.tile.contentView = nil;
  }
  [self.tile display];
}

- (void)setDockTile:(NSDockTile*)dockTile {
  NSDistributedNotificationCenter* center =
      NSDistributedNotificationCenter.defaultCenter;
  [center removeObserver:self];
  self.tile = dockTile;
  if (!dockTile) {
    return;
  }
  [center addObserver:self
             selector:@selector(update)
                 name:kDockIconChanged
               object:nil];
  [self update];
}

- (void)dealloc {
  [NSDistributedNotificationCenter.defaultCenter removeObserver:self];
}

@end
