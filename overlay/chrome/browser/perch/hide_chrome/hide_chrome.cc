// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/hide_chrome/hide_chrome.h"

#include <map>
#include <memory>

#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "chrome/browser/perch/hide_chrome/hide_chrome_mac.h"
#include "chrome/browser/perch/onboarding/onboarding.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_change_type.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/location_bar/location_bar_view.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/web_contents.h"
#include "ui/views/focus/focus_manager.h"

namespace perch {

namespace {

// Hides the bars again when focus leaves the address bar that ⌘L revealed.
class FocusWatcher : public views::FocusChangeListener {
 public:
  explicit FocusWatcher(BrowserWindowInterface* browser) : browser_(browser) {}

  void OnWillChangeFocus(views::View* before, views::View* now) override {}
  void OnDidChangeFocus(views::View* before, views::View* now) override {
    BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
    views::View* location_bar = view ? view->GetLocationBarView() : nullptr;
    const bool in_location_bar =
        now && location_bar && location_bar->Contains(now);
    if (!in_location_bar) {
      SetChromeRevealed(browser_, false);
    }
  }

 private:
  raw_ptr<BrowserWindowInterface> browser_;
};

void Relayout(BrowserWindowInterface* browser);

// Tracks whether the welcome page is the window's active tab: while it is,
// the bars are hidden whatever the setting, and nothing reveals them.
class WelcomeWatcher : public TabStripModelObserver {
 public:
  explicit WelcomeWatcher(BrowserWindowInterface* browser) : browser_(browser) {
    browser_->GetTabStripModel()->AddObserver(this);
    showing_ = Showing();
  }
  ~WelcomeWatcher() override {
    if (TabStripModel* model = browser_->GetTabStripModel()) {
      model->RemoveObserver(this);
    }
  }

  bool showing() const { return showing_; }

  void OnTabStripModelChanged(TabStripModel* model,
                              const TabStripModelChange& change,
                              const TabStripSelectionChange& selection) override {
    Update();
  }
  void OnTabChangedAt(tabs::TabInterface* tab, TabChangeType type) override {
    Update();
  }

 private:
  bool Showing() const {
    content::WebContents* active =
        browser_->GetTabStripModel()->GetActiveWebContents();
    return active && IsWelcomeURL(active->GetVisibleURL());
  }
  void Update() {
    const bool now = Showing();
    if (now != showing_) {
      showing_ = now;
      Relayout(browser_);
    }
  }

  raw_ptr<BrowserWindowInterface> browser_;
  bool showing_ = false;
};

struct WindowState {
  PrefChangeRegistrar registrar;
  std::unique_ptr<WelcomeWatcher> welcome;
  bool revealed = false;
  std::unique_ptr<FocusWatcher> focus;
  raw_ptr<views::FocusManager> focus_manager = nullptr;
  std::unique_ptr<HideChromeMonitor> monitor;
};

std::map<const BrowserWindowInterface*, std::unique_ptr<WindowState>>&
Windows() {
  static base::NoDestructor<
      std::map<const BrowserWindowInterface*, std::unique_ptr<WindowState>>>
      windows;
  return *windows;
}

bool WelcomeShowing(const BrowserWindowInterface* browser) {
  auto it = Windows().find(browser);
  return it != Windows().end() && it->second->welcome &&
         it->second->welcome->showing();
}

void Relayout(BrowserWindowInterface* browser) {
  // The welcome page keeps the window's close, minimise and zoom buttons.
  SetTrafficLightsHidden(browser,
                         IsChromeHidden(browser) && !WelcomeShowing(browser));
  if (BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser)) {
    view->ToolbarSizeChanged(/*is_animating=*/false);
    view->InvalidateLayout();
  }
}

}  // namespace

bool IsChromeHidden(const BrowserWindowInterface* browser) {
  auto it = Windows().find(browser);
  if (it == Windows().end()) {
    return false;
  }
  if (it->second->welcome && it->second->welcome->showing()) {
    return true;
  }
  if (it->second->revealed) {
    return false;
  }
  const PrefService* prefs = it->second->registrar.prefs();
  return prefs && prefs->GetBoolean(prefs::kAppearanceHideChrome);
}

void SetChromeRevealed(BrowserWindowInterface* browser, bool revealed) {
  auto it = Windows().find(browser);
  if (it == Windows().end() || it->second->revealed == revealed) {
    return;
  }
  const bool was_hidden = IsChromeHidden(browser);
  it->second->revealed = revealed;
  if (was_hidden != IsChromeHidden(browser)) {
    Relayout(browser);
  }
}

void ToggleHideChrome(BrowserWindowInterface* browser) {
  PrefService* prefs = browser->GetProfile()->GetPrefs();
  prefs->SetBoolean(prefs::kAppearanceHideChrome,
                    !prefs->GetBoolean(prefs::kAppearanceHideChrome));
}

void WatchHideChrome(BrowserWindowInterface* browser) {
  auto state = std::make_unique<WindowState>();
  state->registrar.Init(browser->GetProfile()->GetPrefs());
  state->registrar.Add(prefs::kAppearanceHideChrome,
                       base::BindRepeating(&Relayout, browser));
  if (BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser)) {
    state->focus_manager = view->GetFocusManager();
    if (state->focus_manager) {
      state->focus = std::make_unique<FocusWatcher>(browser);
      state->focus_manager->AddFocusChangeListener(state->focus.get());
    }
  }
  state->monitor = CreateHideChromeMonitor(browser);
  state->welcome = std::make_unique<WelcomeWatcher>(browser);
  Windows()[browser] = std::move(state);
  if (IsChromeHidden(browser)) {
    Relayout(browser);
  }
}

void UnwatchHideChrome(BrowserWindowInterface* browser) {
  auto it = Windows().find(browser);
  if (it == Windows().end()) {
    return;
  }
  if (it->second->focus_manager && it->second->focus) {
    it->second->focus_manager->RemoveFocusChangeListener(
        it->second->focus.get());
  }
  Windows().erase(it);
}

}  // namespace perch
