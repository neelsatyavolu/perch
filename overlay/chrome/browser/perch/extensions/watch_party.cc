// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/extensions/watch_party.h"

#include <string_view>

#include "base/containers/fixed_flat_set.h"
#include "base/functional/callback_helpers.h"
#include "chrome/browser/perch/extensions/perch_component_extensions.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/extensions/extensions_container.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace perch {

namespace {

// Backrow's content script hosts (its manifest.json).
constexpr auto kHosts = base::MakeFixedFlatSet<std::string_view>({
    "www.netflix.com", "www.hulu.com", "www.peacocktv.com", "www.youtube.com",
    "m.youtube.com", "www.primevideo.com", "play.hbomax.com",
    "www.disneyplus.com",
});

bool BackrowEnabled(Profile* profile) {
  for (const BuiltInExtensionState& state : ListBuiltInExtensions(profile)) {
    if (state.name == "backrow") {
      return state.enabled;
    }
  }
  return false;
}

}  // namespace

bool CanStartWatchParty(Profile* profile, const GURL& url) {
  return url.SchemeIs(url::kHttpsScheme) && kHosts.contains(url.host()) &&
         BackrowEnabled(profile);
}

void StartWatchParty(tabs::TabInterface* tab) {
  BrowserWindowInterface* browser = tab ? tab->GetBrowserWindowInterface() : nullptr;
  if (!browser) {
    return;
  }
  TabStripModel* tabs = browser->GetTabStripModel();
  const int index = tabs->GetIndexOfTab(tab);
  if (index != TabStripModel::kNoTab) {
    tabs->ActivateTabAt(index);
  }
  ExtensionsContainer* container = ExtensionsContainer::From(*browser);
  if (container && container->ShowToolbarActionPopupForAPICall(
                       kBackrowExtensionId, base::DoNothing())) {
    return;
  }
  browser->OpenURL(
      content::OpenURLParams(
          GURL(std::string("chrome-extension://") + kBackrowExtensionId +
               "/popup.html"),
          content::Referrer(), WindowOpenDisposition::kNewForegroundTab,
          ui::PAGE_TRANSITION_AUTO_TOPLEVEL, false),
      {});
}

}  // namespace perch
