// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/agent_tabs.h"

#include <algorithm>
#include <map>
#include <memory>
#include <utility>
#include <vector>

#include "base/auto_reset.h"
#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/observer_list.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_id.h"
#include "chrome/browser/ui/side_panel/side_panel_ui.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model_observer.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/page_transition_types.h"
#include "ui/gfx/geometry/rect.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace perch {

namespace {

// A desktop-sized page, so sites lay out as they would for the user.
constexpr gfx::Rect kAgentWindowBounds(0, 0, 1280, 900);

bool g_creating = false;

base::ObserverList<AgentTabsObserver>& Observers() {
  static base::NoDestructor<base::ObserverList<AgentTabsObserver>> list;
  return *list;
}

void Notify() {
  for (AgentTabsObserver& observer : Observers()) {
    observer.OnAgentTabsChanged();
  }
}

// One profile's hidden window, watched so the toolbar hears about its tabs.
class AgentWindow : public TabStripModelObserver {
 public:
  explicit AgentWindow(BrowserWindowInterface* browser) : browser_(browser) {
    browser->GetTabStripModel()->AddObserver(this);
  }
  AgentWindow(const AgentWindow&) = delete;
  AgentWindow& operator=(const AgentWindow&) = delete;
  ~AgentWindow() override = default;

  BrowserWindowInterface* browser() const { return browser_; }
  bool gone() const { return gone_; }

  // TabStripModelObserver:
  void OnTabStripModelChanged(TabStripModel* model,
                              const TabStripModelChange& change,
                              const TabStripSelectionChange& selection) override {
    Notify();
  }
  void OnTabChangedAt(tabs::TabInterface* tab,
                      TabChangeType change_type) override {
    Notify();
  }
  // The last tab closed or moved out: Chromium closes the window.
  void TabStripEmpty() override { Forget(); }
  void OnTabStripModelDestroyed(TabStripModel* model) override { Forget(); }

 private:
  void Forget();

  raw_ptr<BrowserWindowInterface> browser_;
  bool gone_ = false;
};

std::map<Profile*, std::unique_ptr<AgentWindow>>& Windows() {
  static base::NoDestructor<std::map<Profile*, std::unique_ptr<AgentWindow>>>
      windows;
  return *windows;
}

void AgentWindow::Forget() {
  if (gone_) {
    return;
  }
  gone_ = true;
  // Dropped after the tab strip's own notification has finished.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(
                     [](AgentWindow* window) {
                       std::erase_if(Windows(), [window](const auto& entry) {
                         return entry.second.get() == window;
                       });
                       Notify();
                     },
                     this));
}

BrowserWindowInterface* AgentWindowFor(Profile* profile, bool create) {
  auto it = Windows().find(profile);
  if (it != Windows().end() && !it->second->gone() &&
      !it->second->browser()->IsDeleteScheduled()) {
    return it->second->browser();
  }
  if (!create || GetBrowserWindowCreationStatusForProfile(*profile) !=
                     BrowserWindowInterface::CreationStatus::kOk) {
    return nullptr;
  }
  BrowserWindowCreateParams params(BrowserWindowInterface::TYPE_NORMAL,
                                   *profile, /*from_user_gesture=*/false);
  params.omit_from_session_restore = true;
  params.should_trigger_session_restore = false;
  params.initial_bounds = kAgentWindowBounds;
  BrowserWindowInterface* browser = nullptr;
  {
    base::AutoReset<bool> creating(&g_creating, true);
    browser = CreateBrowserWindow(std::move(params));
  }
  if (!browser || !browser->GetTabStripModel()) {
    return nullptr;
  }
  Windows()[profile] = std::make_unique<AgentWindow>(browser);
  return browser;
}

// A window showing agent tabs the user picked from the Agent Tabs list. Each
// is only on loan: when the user switches to another tab, it goes back to the
// agent window, as in Aside. A tab the user moved elsewhere stays there.
class LoanWatcher : public TabStripModelObserver {
 public:
  explicit LoanWatcher(BrowserWindowInterface* browser) : browser_(browser) {
    browser->GetTabStripModel()->AddObserver(this);
  }
  LoanWatcher(const LoanWatcher&) = delete;
  LoanWatcher& operator=(const LoanWatcher&) = delete;
  ~LoanWatcher() override = default;

  void Lend(tabs::TabInterface* tab) { loaned_.push_back(tab->GetWeakPtr()); }

  // TabStripModelObserver:
  void OnTabStripModelChanged(TabStripModel* model,
                              const TabStripModelChange& change,
                              const TabStripSelectionChange& selection) override {
    std::erase_if(loaned_, [](const auto& tab) { return !tab; });
    if (!selection.active_tab_changed() || !selection.old_tab) {
      return;
    }
    tabs::TabInterface* left = selection.old_tab;
    auto it = std::find_if(loaned_.begin(), loaned_.end(),
                           [left](const auto& tab) { return tab.get() == left; });
    if (it == loaned_.end()) {
      return;
    }
    base::WeakPtr<tabs::TabInterface> tab = *it;
    loaned_.erase(it);
    // After the tab strip has finished telling everyone about the switch.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(
                       [](base::WeakPtr<tabs::TabInterface> tab,
                          BrowserWindowInterface* from) {
                         if (tab && tab->GetBrowserWindowInterface() == from &&
                             !tab->IsActivated()) {
                           MoveToAgentWindow(tab.get());
                         }
                       },
                       tab, browser_.get()));
  }
  void OnTabStripModelDestroyed(TabStripModel* model) override;

 private:
  raw_ptr<BrowserWindowInterface> browser_;
  std::vector<base::WeakPtr<tabs::TabInterface>> loaned_;
};

std::map<BrowserWindowInterface*, std::unique_ptr<LoanWatcher>>& Loans() {
  static base::NoDestructor<
      std::map<BrowserWindowInterface*, std::unique_ptr<LoanWatcher>>>
      loans;
  return *loans;
}

void LoanWatcher::OnTabStripModelDestroyed(TabStripModel* model) {
  model->RemoveObserver(this);
  BrowserWindowInterface* browser = browser_;
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE,
      base::BindOnce([](BrowserWindowInterface* browser) { Loans().erase(browser); },
                     browser));
}

}  // namespace

void AddAgentTabsObserver(AgentTabsObserver* observer) {
  Observers().AddObserver(observer);
}

void RemoveAgentTabsObserver(AgentTabsObserver* observer) {
  Observers().RemoveObserver(observer);
}

content::WebContents* OpenAgentTab(Profile* profile, const GURL& url) {
  BrowserWindowInterface* browser = AgentWindowFor(profile, /*create=*/true);
  if (!browser) {
    return nullptr;
  }
  std::unique_ptr<content::WebContents> contents =
      content::WebContents::Create(content::WebContents::CreateParams(profile));
  content::WebContents* raw = contents.get();
  // Loading even about:blank starts the page's renderer, which every
  // command an agent sends to the tab waits for.
  raw->GetController().LoadURL(url.is_valid() ? url : GURL(url::kAboutBlankURL),
                               content::Referrer(),
                               ui::PAGE_TRANSITION_AUTO_TOPLEVEL, std::string());
  browser->GetTabStripModel()->AppendWebContents(std::move(contents),
                                                 /*foreground=*/true);
  return raw;
}

bool IsAgentWindow(const BrowserWindowInterface* browser) {
  if (g_creating) {
    return true;
  }
  for (const auto& [profile, window] : Windows()) {
    if (window->browser() == browser) {
      return true;
    }
  }
  return false;
}

bool IsCreatingAgentWindow() {
  return g_creating;
}

std::vector<tabs::TabInterface*> AgentTabsFor(Profile* profile) {
  std::vector<tabs::TabInterface*> tabs;
  BrowserWindowInterface* browser = AgentWindowFor(profile, /*create=*/false);
  if (!browser) {
    return tabs;
  }
  TabStripModel* model = browser->GetTabStripModel();
  for (int i = 0; i < model->count(); ++i) {
    tabs.push_back(model->GetTabAtIndex(i));
  }
  return tabs;
}

void ShowAgentTab(tabs::TabInterface* tab, BrowserWindowInterface* into) {
  BrowserWindowInterface* from = tab ? tab->GetBrowserWindowInterface() : nullptr;
  if (!from || !into || from == into || !IsAgentWindow(from)) {
    return;
  }
  TabStripModel* source = from->GetTabStripModel();
  const int index = source->GetIndexOfTab(tab);
  if (index == TabStripModel::kNoTab) {
    return;
  }
  std::unique_ptr<tabs::TabModel> moved = source->DetachTabAtForInsertion(index);
  TabStripModel* target = into->GetTabStripModel();
  tabs::TabInterface* shown = moved.get();
  target->InsertDetachedTabAt(target->count(), std::move(moved),
                              AddTabTypes::ADD_ACTIVE);
  auto& watcher = Loans()[into];
  if (!watcher) {
    watcher = std::make_unique<LoanWatcher>(into);
  }
  watcher->Lend(shown);
  // The sidebar opens beside it, on the chat whose agent works in the tab.
  if (SidePanelUI* panel = SidePanelUI::From(into)) {
    panel->Show(SidePanelEntryId::kPerch);
  }
}

bool MoveToAgentWindow(tabs::TabInterface* tab) {
  BrowserWindowInterface* from = tab ? tab->GetBrowserWindowInterface() : nullptr;
  if (!from || IsAgentWindow(from)) {
    return false;
  }
  TabStripModel* source = from->GetTabStripModel();
  const int index = source->GetIndexOfTab(tab);
  // The window's only tab stays: moving it would close the user's window.
  if (index == TabStripModel::kNoTab || source->count() < 2) {
    return false;
  }
  BrowserWindowInterface* agent =
      AgentWindowFor(from->GetProfile(), /*create=*/true);
  if (!agent || agent == from) {
    return false;
  }
  std::unique_ptr<tabs::TabModel> moved = source->DetachTabAtForInsertion(index);
  TabStripModel* target = agent->GetTabStripModel();
  target->InsertDetachedTabAt(target->count(), std::move(moved),
                              AddTabTypes::ADD_ACTIVE);
  return true;
}

void CloseAgentTabs(Profile* profile) {
  if (BrowserWindowInterface* browser =
          AgentWindowFor(profile, /*create=*/false)) {
    browser->GetTabStripModel()->CloseAllTabs();
  }
}

}  // namespace perch
