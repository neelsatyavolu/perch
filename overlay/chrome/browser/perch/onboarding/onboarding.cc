// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/onboarding/onboarding.h"

#include <set>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/no_destructor.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/scheme/perch_scheme.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui/webui_embedding_context.h"
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

// Profiles whose welcome page has opened in this run; a second window of the
// same profile doesn't get another.
std::set<base::FilePath>& Started() {
  static base::NoDestructor<std::set<base::FilePath>> started;
  return *started;
}

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

void MaybeStartOnboarding(BrowserWindowInterface* browser) {
  // Headless runs add --no-first-run themselves; --force-first-run wins.
  const base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (command_line->HasSwitch(switches::kNoFirstRun) &&
      !command_line->HasSwitch(switches::kForceFirstRun)) {
    return;
  }
  Profile* profile = browser->GetProfile();
  if (!profile->IsRegularProfile() || profile->IsOffTheRecord() ||
      browser->GetType() != BrowserWindowInterface::TYPE_NORMAL ||
      profile->GetPrefs()->GetBoolean(prefs::kOnboardingFinished) ||
      !Started().insert(profile->GetPath()).second) {
    return;
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
  if (!browser->GetWindow()->IsFullscreen()) {
    chrome::ToggleFullscreenMode(browser);
  }
}

void FinishOnboarding(content::WebContents* welcome) {
  Profile::FromBrowserContext(welcome->GetBrowserContext())
      ->GetPrefs()
      ->SetBoolean(prefs::kOnboardingFinished, true);
  // Back out of the full screen the welcome page went into.
  BrowserWindowInterface* browser = webui::GetBrowserWindowInterface(welcome);
  if (browser && browser->GetWindow()->IsFullscreen()) {
    chrome::ToggleFullscreenMode(browser);
  }
}

}  // namespace perch
