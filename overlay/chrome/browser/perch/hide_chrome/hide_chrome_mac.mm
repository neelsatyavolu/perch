// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/hide_chrome/hide_chrome_mac.h"

#import <AppKit/AppKit.h>
#include <Carbon/Carbon.h>

#include "base/memory/raw_ptr.h"
#include "base/timer/timer.h"
#include "chrome/browser/perch/hide_chrome/hide_chrome.h"
#include "chrome/browser/perch/perch_command_ids.h"
#include "chrome/browser/perch/perch_commands.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/frame/top_container_view.h"
#include "chrome/browser/ui/views/location_bar/location_bar_view.h"
#include "components/prefs/pref_service.h"
#include "ui/views/focus/focus_manager.h"
#include "ui/views/widget/widget.h"

namespace perch {

namespace {

constexpr CGFloat kRevealEdge = 4;
constexpr base::TimeDelta kRevealDelay = base::Milliseconds(150);
// How far below the bars the pointer can wander before they hide again.
constexpr CGFloat kHideSlack = 8;

NSWindow* WindowFor(BrowserWindowInterface* browser) {
  BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser);
  if (!view || !view->GetWidget()) {
    return nil;
  }
  return view->GetWidget()->GetNativeWindow().GetNativeNSWindow();
}

bool HideChromeOn(BrowserWindowInterface* browser) {
  return browser->GetProfile()->GetPrefs()->GetBoolean(
      prefs::kAppearanceHideChrome);
}

class MonitorMac : public HideChromeMonitor {
 public:
  explicit MonitorMac(BrowserWindowInterface* browser) : browser_(browser) {
    MonitorMac* self = this;
    monitor_ = [NSEvent
        addLocalMonitorForEventsMatchingMask:(NSEventMaskMouseMoved |
                                              NSEventMaskKeyDown)
                                     handler:^NSEvent*(NSEvent* event) {
                                       return self->Handle(event);
                                     }];
  }

  ~MonitorMac() override {
    if (monitor_) {
      [NSEvent removeMonitor:monitor_];
    }
  }

 private:
  NSEvent* Handle(NSEvent* event) {
    NSWindow* window = WindowFor(browser_);
    if (!window || event.window != window || !HideChromeOn(browser_)) {
      return event;
    }
    if (event.type == NSEventTypeKeyDown) {
      const NSEventModifierFlags mods =
          event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
      if (event.keyCode == kVK_Tab && mods == NSEventModifierFlagControl &&
          IsChromeHidden(browser_)) {
        ExecutePerchCommand(browser_, IDC_PERCH_COMMAND_BAR);
        return nil;
      }
      return event;
    }
    OnMouseMoved(window, event);
    return event;
  }

  void OnMouseMoved(NSWindow* window, NSEvent* event) {
    const CGFloat from_top =
        NSHeight(window.contentView.frame) - event.locationInWindow.y;
    if (IsChromeHidden(browser_)) {
      const bool reveal_on_hover = browser_->GetProfile()->GetPrefs()->GetBoolean(
          prefs::kAppearanceRevealOnHover);
      if (!reveal_on_hover || from_top > kRevealEdge) {
        timer_.Stop();
        return;
      }
      if (!timer_.IsRunning()) {
        timer_.Start(FROM_HERE, kRevealDelay,
                     base::BindOnce(&MonitorMac::Reveal, base::Unretained(this)));
      }
      return;
    }
    if (hover_revealed_ && from_top > BarsBottom() + kHideSlack &&
        !AddressBarFocused()) {
      hover_revealed_ = false;
      SetChromeRevealed(browser_, false);
    }
  }

  void Reveal() {
    hover_revealed_ = true;
    SetChromeRevealed(browser_, true);
  }

  CGFloat BarsBottom() {
    BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
    return view ? view->top_container()->bounds().bottom() : 0;
  }

  bool AddressBarFocused() {
    BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
    if (!view || !view->GetFocusManager()) {
      return false;
    }
    views::View* focused = view->GetFocusManager()->GetFocusedView();
    views::View* location_bar = view->GetLocationBarView();
    return focused && location_bar && location_bar->Contains(focused);
  }

  raw_ptr<BrowserWindowInterface> browser_;
  id monitor_ = nil;
  base::OneShotTimer timer_;
  bool hover_revealed_ = false;
};

}  // namespace

void SetTrafficLightsHidden(BrowserWindowInterface* browser, bool hidden) {
  NSWindow* window = WindowFor(browser);
  for (NSWindowButton kind :
       {NSWindowCloseButton, NSWindowMiniaturizeButton, NSWindowZoomButton}) {
    [window standardWindowButton:kind].hidden = hidden;
  }
}

std::unique_ptr<HideChromeMonitor> CreateHideChromeMonitor(
    BrowserWindowInterface* browser) {
  return std::make_unique<MonitorMac>(browser);
}

}  // namespace perch
