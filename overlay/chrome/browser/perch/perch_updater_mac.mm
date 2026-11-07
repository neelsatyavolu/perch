// Copyright 2026 Neel Satyavolu. MIT licence, see LICENSE in the Perch repo.

#import "chrome/browser/perch/perch_updater_mac.h"

#import <AppKit/AppKit.h>

#include "base/apple/bundle_locations.h"
#include "chrome/browser/perch/privacy/allowed_connections.h"

// The Sparkle methods Perch calls. Sparkle is loaded at runtime, so nothing
// links against it and builds without it still work.
@protocol PerchSparkleUpdater <NSObject>
@property(nonatomic) BOOL automaticallyChecksForUpdates;
@end

@protocol PerchSparkleUpdaterController <NSObject>
- (instancetype)initWithStartingUpdater:(BOOL)startUpdater
                        updaterDelegate:(id)updaterDelegate
                     userDriverDelegate:(id)userDriverDelegate;
- (void)checkForUpdates:(id)sender;
@property(nonatomic, readonly) id<PerchSparkleUpdater> updater;
@end

namespace perch {

namespace {

id<PerchSparkleUpdaterController> g_updater_controller = nil;

void AddCheckForUpdatesItem(id<PerchSparkleUpdaterController> controller) {
  NSMenu* main_menu = NSApp.mainMenu;
  if (main_menu.numberOfItems == 0) {
    return;
  }
  NSMenu* app_menu = [main_menu itemAtIndex:0].submenu;
  if (!app_menu) {
    return;
  }
  NSMenuItem* item =
      [[NSMenuItem alloc] initWithTitle:@"Check for Updates…"
                                 action:@selector(checkForUpdates:)
                          keyEquivalent:@""];
  item.target = controller;
  [app_menu insertItem:item atIndex:MIN(1, app_menu.numberOfItems)];
}

}  // namespace

void StartUpdater() {
  if (g_updater_controller) {
    return;
  }
  NSURL* framework_url = [base::apple::OuterBundle().privateFrameworksURL
      URLByAppendingPathComponent:@"Sparkle.framework"];
  NSBundle* sparkle = [NSBundle bundleWithURL:framework_url];
  if (!sparkle || ![sparkle load]) {
    return;
  }
  Class controller_class = NSClassFromString(@"SPUStandardUpdaterController");
  if (!controller_class) {
    return;
  }
  g_updater_controller =
      [(id<PerchSparkleUpdaterController>)[controller_class alloc]
          initWithStartingUpdater:YES
                  updaterDelegate:nil
               userDriverDelegate:nil];
  // Scheduled checks follow Settings → Privacy → Perch updates; "Check for
  // Updates…" always works.
  g_updater_controller.updater.automaticallyChecksForUpdates =
      IsConnectionAllowed(Connection::kPerchUpdates);
  AddCheckForUpdatesItem(g_updater_controller);
}

}  // namespace perch
