// Copyright 2026 Neel Satyavolu. MIT licence, see LICENSE in the Perch repo.

#import "chrome/browser/perch/perch_updater_mac.h"

#import <AppKit/AppKit.h>

#include "base/apple/bundle_locations.h"
#include "base/apple/foundation_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/time/time.h"
#include "chrome/browser/perch/perch_update_policy.h"
#include "chrome/browser/perch/privacy/allowed_connections.h"

// The Sparkle methods Perch calls. Sparkle is loaded at runtime, so nothing
// links against it and builds without it still work.
@protocol PerchSparkleUpdater <NSObject>
@property(nonatomic) BOOL automaticallyChecksForUpdates;
@property(nonatomic) BOOL automaticallyDownloadsUpdates;
@property(nonatomic, readonly) NSDate* lastUpdateCheckDate;
- (void)checkForUpdatesInBackground;
@end

@protocol PerchSparkleAppcastItem <NSObject>
@property(nonatomic, readonly) NSDate* date;
@property(nonatomic, readonly) NSString* channel;
@property(nonatomic, readonly) NSString* displayVersionString;
@end

@protocol PerchSparkleAppcast <NSObject>
@property(nonatomic, readonly) NSArray* items;
@end

// Applies the update policies to what Sparkle offers (enterprise task 9), and
// keeps a downloaded update ready to install on Restart (Settings › About and
// the app menu), since a browser can stay open for weeks between quits.
@interface PerchUpdaterDelegate : NSObject
- (instancetype)initWithPolicy:(const perch::UpdatePolicy&)policy;
// The version that has downloaded and waits to install; nil until one has.
@property(nonatomic, readonly, copy) NSString* readyVersion;
// Installs the downloaded update and relaunches Perch. NO when none is ready.
- (BOOL)installNow;
- (void)installNow:(id)sender;
@end

@implementation PerchUpdaterDelegate {
  perch::UpdatePolicy _policy;
  void (^_installHandler)(void);
}

@synthesize readyVersion = _readyVersion;

// Sparkle has downloaded an update and will install it when Perch quits.
// Returning YES keeps the immediate-install block for Restart; Sparkle still
// installs the update on quit if it is never used.
- (BOOL)updater:(id)updater
       willInstallUpdateOnQuit:(id<PerchSparkleAppcastItem>)item
    immediateInstallationBlock:(void (^)(void))installHandler {
  _installHandler = [installHandler copy];
  _readyVersion = [item.displayVersionString copy] ?: @"";
  perch::ShowRestartToUpdateItem();
  return YES;
}

- (BOOL)installNow {
  if (!_installHandler) {
    return NO;
  }
  _installHandler();
  return YES;
}

- (void)installNow:(id)sender {
  [self installNow];
}

- (instancetype)initWithPolicy:(const perch::UpdatePolicy&)policy {
  if ((self = [super init])) {
    _policy = policy;
  }
  return self;
}

- (NSSet<NSString*>*)allowedChannelsForUpdater:(id)updater {
  return _policy.channel == "beta" ? [NSSet setWithObject:@"beta"]
                                   : [NSSet set];
}

// The newest item the policies allow, or Sparkle's empty item when none is.
- (id)bestValidUpdateInAppcast:(id<PerchSparkleAppcast>)appcast
                    forUpdater:(id)updater {
  const base::Time now = base::Time::Now();
  for (id<PerchSparkleAppcastItem> item in appcast.items) {
    const base::Time published =
        item.date ? base::Time::FromNSDate(item.date) : now;
    const std::string channel =
        item.channel ? base::SysNSStringToUTF8(item.channel) : std::string();
    if (perch::ShouldOffer(_policy, published, channel, now)) {
      return item;
    }
  }
  Class item_class = NSClassFromString(@"SUAppcastItem");
  return [item_class performSelector:@selector(emptyAppcastItem)];
}

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
PerchUpdaterDelegate* g_updater_delegate = nil;
// The app menu's "Check for Updates…", which becomes "Restart to Update Perch"
// once an update is ready.
NSMenuItem* g_update_item = nil;

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
  g_update_item = item;
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
  const UpdatePolicy policy = ReadUpdatePolicy();
  g_updater_delegate = [[PerchUpdaterDelegate alloc] initWithPolicy:policy];
  g_updater_controller =
      [(id<PerchSparkleUpdaterController>)[controller_class alloc]
          initWithStartingUpdater:YES
                  updaterDelegate:g_updater_delegate
               userDriverDelegate:nil];
  id<PerchSparkleUpdater> updater = g_updater_controller.updater;
  // A company that turns updates off gets no checks and no menu item.
  if (!policy.auto_update) {
    updater.automaticallyChecksForUpdates = NO;
    return;
  }
  // Below the company's minimum version, Perch checks now and installs the
  // update when it quits, whatever the switch says.
  NSString* running = base::apple::ObjCCast<NSString>([base::apple::OuterBundle()
      objectForInfoDictionaryKey:@"CFBundleShortVersionString"]);
  if (running && BelowMinimumVersion(policy, base::SysNSStringToUTF8(running))) {
    updater.automaticallyDownloadsUpdates = YES;
    [updater checkForUpdatesInBackground];
  } else {
    // Scheduled checks follow Settings → Privacy → Perch updates; "Check for
    // Updates…" always works.
    updater.automaticallyChecksForUpdates =
        IsConnectionAllowed(Connection::kPerchUpdates);
  }
  AddCheckForUpdatesItem(g_updater_controller);
}

UpdaterInfo GetUpdaterInfo() {
  UpdaterInfo info;
  info.managed = !ReadUpdatePolicy().auto_update;
  if (!g_updater_controller) {
    return info;
  }
  id<PerchSparkleUpdater> updater = g_updater_controller.updater;
  info.available = true;
  info.auto_update = updater.automaticallyChecksForUpdates;
  if (NSDate* last = updater.lastUpdateCheckDate) {
    info.last_checked = base::Time::FromNSDate(last);
  }
  if (NSString* ready = g_updater_delegate.readyVersion) {
    info.ready_version = base::SysNSStringToUTF8(ready);
  }
  return info;
}

bool SetAutoUpdate(bool on) {
  if (!g_updater_controller || !ReadUpdatePolicy().auto_update) {
    return false;
  }
  g_updater_controller.updater.automaticallyChecksForUpdates = on;
  return true;
}

void ShowRestartToUpdateItem() {
  if (!g_update_item || !g_updater_delegate.readyVersion) {
    return;
  }
  g_update_item.title = @"Restart to Update Perch";
  g_update_item.target = g_updater_delegate;
  g_update_item.action = @selector(installNow:);
}

bool InstallReadyUpdate() {
  return g_updater_delegate && [g_updater_delegate installNow];
}

bool CheckForUpdatesNow() {
  if (!g_updater_controller || !ReadUpdatePolicy().auto_update) {
    return false;
  }
  [g_updater_controller checkForUpdates:nil];
  return true;
}

}  // namespace perch
