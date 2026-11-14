// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/onboarding/onboarding.h"

#include <map>
#include <set>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/no_destructor.h"
#include "base/time/time.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/scheme/perch_scheme.h"
#include "base/functional/bind.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/common/chrome_switches.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/referrer.h"
#include "content/public/common/url_constants.h"
#include "ui/base/base_window.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr char kWelcomeURL[] = "chrome://perch-welcome/";
constexpr char kTourURL[] = "chrome://perch-tour/";

// Profiles whose welcome page has opened in this run; a second window of the
// same profile doesn't get another.
std::set<base::FilePath>& Started() {
  static base::NoDestructor<std::set<base::FilePath>> started;
  return *started;
}

// When each profile finished setup this run; extension tabs stay held back for
// a while after, since Web Store installs from the import finish late.
std::map<base::FilePath, base::TimeTicks>& FinishedAt() {
  static base::NoDestructor<std::map<base::FilePath, base::TimeTicks>> at;
  return *at;
}

constexpr base::TimeDelta kHoldAfterSetup = base::Minutes(5);

bool IsNewTabURL(const GURL& url) {
  return IsPerchNewTabURL(url) ||
         (url.SchemeIs(content::kChromeUIScheme) && url.host() == "newtab") ||
         (url.SchemeIs(kPerchScheme) && url.host() == "newtab");
}

}  // namespace

// A tab shows perch://welcome while its real address is
// chrome://perch-welcome; either may be asked about.
bool IsWelcomeURL(const GURL& url) {
  return (url.SchemeIs(content::kChromeUIScheme) &&
          url.host() == "perch-welcome") ||
         (url.SchemeIs(kPerchScheme) && url.host() == "welcome");
}

namespace {

// Set up before the tour existed, or left it unfinished: it opens once per
// run, in front, until it is finished or skipped (FinishTour).
void MaybeStartTour(BrowserWindowInterface* browser) {
  Profile* profile = browser->GetProfile();
  if (profile->GetPrefs()->GetBoolean(prefs::kTourFinished) ||
      FinishedAt().contains(profile->GetPath()) ||
      !Started().insert(profile->GetPath()).second) {
    return;
  }
  TabStripModel* strip = browser->GetTabStripModel();
  for (int i = 0; i < strip->count(); ++i) {
    if (IsTourURL(strip->GetWebContentsAt(i)->GetVisibleURL())) {
      strip->ActivateTabAt(i);
      return;
    }
  }
  content::WebContents* active = strip->GetActiveWebContents();
  const bool replace = active && IsNewTabURL(active->GetVisibleURL());
  browser->OpenURL(
      content::OpenURLParams(GURL(kTourURL), content::Referrer(),
                             replace ? WindowOpenDisposition::kCurrentTab
                                     : WindowOpenDisposition::kNewForegroundTab,
                             ui::PAGE_TRANSITION_AUTO_TOPLEVEL,
                             /*is_renderer_initiated=*/false),
      {});
}

}  // namespace

namespace {

// Profiles share one window (toolbar/perch_profile_menu.cc), but Chromium
// reopens a window for every profile that had one, hidden ones included. A
// moment after startup, only the last-used profile's windows stay out.
void KeepOneProfileOut() {
  ProfileManager* manager = g_browser_process->profile_manager();
  if (!manager) {
    return;
  }
  const base::FilePath last = manager->GetLastUsedProfileDir();
  std::vector<BrowserWindowInterface*> others;
  bool last_shown = false;
  for (BrowserWindowInterface* window : GetAllBrowserWindowInterfaces()) {
    if (window->GetType() != BrowserWindowInterface::TYPE_NORMAL ||
        !window->GetWindow()->IsVisible()) {
      continue;
    }
    if (window->GetProfile()->GetOriginalProfile()->GetPath() == last) {
      last_shown = true;
    } else {
      others.push_back(window);
    }
  }
  if (!last_shown) {
    return;
  }
  for (BrowserWindowInterface* window : others) {
    window->GetWindow()->Hide();
  }
}

}  // namespace

void MaybeStartOnboarding(BrowserWindowInterface* browser) {
  static bool tidy_scheduled = false;
  if (!tidy_scheduled) {
    tidy_scheduled = true;
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE, base::BindOnce(&KeepOneProfileOut), base::Seconds(3));
  }
  // Headless runs add --no-first-run themselves; --force-first-run wins.
  const base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(switches::kNoFirstRun) &&
      !command_line->HasSwitch(switches::kForceFirstRun)) {
    return;
  }
  Profile* profile = browser->GetProfile();
  if (!profile->IsRegularProfile() || profile->IsOffTheRecord() ||
      browser->GetType() != BrowserWindowInterface::TYPE_NORMAL) {
    return;
  }
  if (profile->GetPrefs()->GetBoolean(prefs::kOnboardingFinished)) {
    MaybeStartTour(browser);
    return;
  }
  if (!Started().insert(profile->GetPath()).second) {
    return;
  }
  // After a restart in the middle of setup (Full Disk Access applies only
  // then), the restored welcome tab is brought forward; the page picks up on
  // the step it was on.
  TabStripModel* strip = browser->GetTabStripModel();
  for (int i = 0; i < strip->count(); ++i) {
    // Restored tabs may not have loaded yet: their visible URL is the one to read.
    if (IsWelcomeURL(strip->GetWebContentsAt(i)->GetVisibleURL())) {
      strip->ActivateTabAt(i);
      if (!browser->GetWindow()->IsFullscreen() &&
          !browser->GetWindow()->IsMaximized()) {
        browser->GetWindow()->Maximize();
      }
      return;
    }
  }
  // A window that opened on the new tab page shows the welcome page in its
  // place; one that opened on something else keeps it, in a tab behind.
  content::WebContents* active =
      browser->GetTabStripModel()->GetActiveWebContents();
  const bool replace = active && IsNewTabURL(active->GetVisibleURL());
  browser->OpenURL(
      content::OpenURLParams(GURL(kWelcomeURL), content::Referrer(),
                             replace ? WindowOpenDisposition::kCurrentTab
                                     : WindowOpenDisposition::kNewForegroundTab,
                             ui::PAGE_TRANSITION_AUTO_TOPLEVEL,
                             /*is_renderer_initiated=*/false),
      {});
  // The welcome page fills the screen by maximizing the window, not by macOS
  // full screen: full screen moves the window to a Space of its own, and
  // during that move (or when a sign-in window takes focus) Chromium can mark
  // the page hidden and stop drawing it.
  if (!browser->GetWindow()->IsFullscreen() &&
      !browser->GetWindow()->IsMaximized()) {
    browser->GetWindow()->Maximize();
  }
}

bool IsTourURL(const GURL& url) {
  return (url.SchemeIs(content::kChromeUIScheme) &&
          url.host() == "perch-tour") ||
         (url.SchemeIs(kPerchScheme) && url.host() == "tour");
}

void FinishTour(Profile* profile) {
  profile->GetOriginalProfile()->GetPrefs()->SetBoolean(prefs::kTourFinished,
                                                        true);
}

bool ExtensionTabsHeldBack(Profile* profile) {
  if (!profile) {
    return false;
  }
  const base::FilePath path = profile->GetOriginalProfile()->GetPath();
  if (Started().contains(path) &&
      !profile->GetPrefs()->GetBoolean(prefs::kOnboardingFinished)) {
    return true;
  }
  auto finished = FinishedAt().find(path);
  return finished != FinishedAt().end() &&
         base::TimeTicks::Now() - finished->second < kHoldAfterSetup;
}

void FinishOnboarding(content::WebContents* welcome) {
  FinishedAt()[Profile::FromBrowserContext(welcome->GetBrowserContext())
                   ->GetOriginalProfile()
                   ->GetPath()] = base::TimeTicks::Now();
  Profile::FromBrowserContext(welcome->GetBrowserContext())
      ->GetPrefs()
      ->SetBoolean(prefs::kOnboardingFinished, true);
}

}  // namespace perch
