// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SIDE_PANEL_PERCH_SIDE_PANEL_CONTROLLER_H_
#define CHROME_BROWSER_PERCH_SIDE_PANEL_PERCH_SIDE_PANEL_CONTROLLER_H_

#include <memory>
#include <string>

#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_observer.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"

class BrowserWindowInterface;
class SidePanelEntryScope;

namespace content {
class WebContents;
}
class SidePanelRegistry;

namespace views {
class View;
}

class SidePanel;

namespace tabs {
class TabInterface;
}

namespace perch {

// The Perch sidebar in one window (spec 5.3): one window-scoped side panel
// entry whose page shows the active tab's side chat. A new tab opened while
// the panel shows keeps it showing. Switching to a tab whose panel was closed
// closes it, and switching back reopens it at once: the page is kept alive
// while closed (side_panel_coordinator.cc), so it never reloads.
class PerchSidePanelController : public TabStripModelObserver,
                                 public SidePanelEntryObserver {
 public:
  PerchSidePanelController(BrowserWindowInterface* browser,
                           SidePanelRegistry& registry);
  PerchSidePanelController(const PerchSidePanelController&) = delete;
  PerchSidePanelController& operator=(const PerchSidePanelController&) =
      delete;
  ~PerchSidePanelController() override;

  // TabStripModelObserver:
  void OnTabStripModelChanged(TabStripModel* tab_strip_model,
                              const TabStripModelChange& change,
                              const TabStripSelectionChange& selection) override;
  void OnTabChangedAt(tabs::TabInterface* tab,
                      TabChangeType change_type) override;

  // SidePanelEntryObserver:
  void OnEntryShown(SidePanelEntry* entry) override;
  void OnEntryWillHide(SidePanelEntry* entry,
                       SidePanelEntryHideReason reason) override;
  void OnEntryHideCancelled(SidePanelEntry* entry) override;
  void OnEntryHidden(SidePanelEntry* entry) override;

  // Opens or closes the sidebar to match what `tab` last had. Called on a
  // tab switch before the browser shows the tab's page.
  void MatchPanelTo(tabs::TabInterface* tab);

 private:
  std::unique_ptr<views::View> CreateView(SidePanelEntryScope& scope);
  void PinOnce();
  void OnWindowReady();
  bool IsShowing() const;
  SidePanel* Panel() const;

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<SidePanelRegistry> registry_;
  std::string window_id_;
  // Set while the panel opens or closes because of a tab switch, so that
  // does not change the tab's remembered state.
  bool switching_ = false;
  // The tab whose panel the user is closing, while the close animates.
  raw_ptr<tabs::TabInterface> hiding_tab_ = nullptr;
  // Whether perchd has had every tab since this window's sidebar first showed.
  bool synced_once_ = false;
  // The width this window's sidebar last had, or 0 before it first closes.
  int width_ = 0;
  base::WeakPtrFactory<PerchSidePanelController> weak_factory_{this};
};

// Called by BrowserWindowFeatures for each window.
void InitWindowFeatures(BrowserWindowInterface* browser,
                        SidePanelRegistry& registry);
void TearDownWindowFeatures(BrowserWindowInterface* browser);

// The tab switch hook (SidePanelUIBase::SetPerchActiveTabHook).
void OnActiveTabChanging(BrowserWindowInterface* browser,
                         content::WebContents* new_contents);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SIDE_PANEL_PERCH_SIDE_PANEL_CONTROLLER_H_
