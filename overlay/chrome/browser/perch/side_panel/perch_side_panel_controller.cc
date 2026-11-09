// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/command_bar/command_bar.h"
#include "chrome/browser/perch/hide_chrome/hide_chrome.h"
#include "chrome/browser/perch/keys/key_broker.h"
#include "chrome/browser/perch/memory_saver/sleep_controller.h"
#include "chrome/browser/perch/perch_menu_mac.h"
#include "chrome/browser/perch/snapshot/chrome_snapshot.h"
#include "chrome/browser/perch/theme/perch_theme.h"
#include "chrome/browser/perch/side_panel/perch_side_panel_controller.h"

#include <map>
#include <set>
#include <string>
#include <utility>

#include "base/auto_reset.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/memory/weak_ptr.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "chrome/browser/perch/agent/perch_devtools.h"
#include "chrome/browser/perch/agent/perchd_launcher.h"
#include "chrome/browser/perch/side_panel/perch_tab_sync.h"
#include "chrome/browser/perch/webui/perch_side_chat_ui.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/actions/chrome_action_id.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/navigator/browser_navigator.h"
#include "chrome/browser/ui/navigator/browser_navigator_params.h"
#include "chrome/browser/ui/side_panel/side_panel_entry.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_id.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_scope.h"
#include "chrome/browser/ui/side_panel/side_panel_enums.h"
#include "chrome/browser/ui/side_panel/side_panel_registry.h"
#include "chrome/browser/ui/side_panel/side_panel_ui.h"
#include "chrome/browser/ui/tabs/tab_change_type.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/toolbar/pinned_toolbar/pinned_toolbar_actions_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/side_panel/side_panel.h"
#include "chrome/browser/ui/views/side_panel/side_panel_web_ui_view.h"
#include "chrome/browser/ui/webui/top_chrome/webui_contents_wrapper.h"
#include "chrome/grit/generated_resources.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/navigation_handle.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_contents_observer.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

using SidePanelWebUIViewT_PerchSideShellUI =
    SidePanelWebUIViewT<perch::PerchSideShellUI>;
BEGIN_TEMPLATE_METADATA(SidePanelWebUIViewT_PerchSideShellUI,
                        SidePanelWebUIViewT)
END_METADATA

namespace perch {

namespace {

constexpr int kDefaultWidth = 420;

const SidePanelEntryKey& PerchKey() {
  static const base::NoDestructor<SidePanelEntryKey> key(
      SidePanelEntryId::kPerch);
  return *key;
}

// The page's close button (window.perchHost.close in config.js) makes a
// same-document navigation to #perch-close-<n>; this closes the panel.
class CloseWatcher : public content::WebContentsObserver {
 public:
  CloseWatcher(content::WebContents* contents, BrowserWindowInterface* browser)
      : content::WebContentsObserver(contents), browser_(browser) {}

  void DidFinishNavigation(content::NavigationHandle* handle) override {
    if (!handle->IsInPrimaryMainFrame() || !handle->IsSameDocument() ||
        !handle->GetURL().ref().starts_with("perch-close-")) {
      return;
    }
    // Not from inside this observer: closing may destroy these contents.
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&CloseWatcher::ClosePanel,
                                  weak_factory_.GetWeakPtr()));
  }

 private:
  void ClosePanel() {
    if (SidePanelUI* side_panel = SidePanelUI::From(browser_)) {
      side_panel->Close();
    }
  }

  raw_ptr<BrowserWindowInterface> browser_;
  base::WeakPtrFactory<CloseWatcher> weak_factory_{this};
};

// Links in the side chat open in a new tab of the same window; the panel
// itself never leaves the chat page.
class PerchSidePanelWebView : public SidePanelWebUIViewT<PerchSideShellUI> {
  using SidePanelWebUIViewT_PerchSideShellUI =
      SidePanelWebUIViewT<PerchSideShellUI>;
  METADATA_HEADER(PerchSidePanelWebView, SidePanelWebUIViewT_PerchSideShellUI)

 public:
  PerchSidePanelWebView(
      SidePanelEntryScope& scope,
      BrowserWindowInterface* browser,
      std::unique_ptr<WebUIContentsWrapperT<PerchSideShellUI>> contents_wrapper)
      : SidePanelWebUIViewT(scope,
                            base::RepeatingClosure(),
                            base::RepeatingClosure(),
                            std::move(contents_wrapper)),
        browser_(browser),
        close_watcher_(this->contents_wrapper()->web_contents(), browser) {}
  PerchSidePanelWebView(const PerchSidePanelWebView&) = delete;
  PerchSidePanelWebView& operator=(const PerchSidePanelWebView&) = delete;
  ~PerchSidePanelWebView() override = default;

  content::WebContents* OpenURLFromTab(
      content::WebContents* source,
      const content::OpenURLParams& params,
      base::OnceCallback<void(content::NavigationHandle&)>
          navigation_handle_callback) override {
    OpenInTab(params.url);
    return nullptr;
  }

  content::WebContents* AddNewContents(
      content::WebContents* source,
      std::unique_ptr<content::WebContents> new_contents,
      const GURL& target_url,
      WindowOpenDisposition disposition,
      const blink::mojom::WindowFeatures& window_features,
      bool user_gesture,
      bool* was_blocked) override {
    OpenInTab(target_url);
    return nullptr;
  }

 private:
  void OpenInTab(const GURL& url) {
    if (!url.SchemeIsHTTPOrHTTPS()) {
      return;
    }
    NavigateParams params(browser_, url, ui::PAGE_TRANSITION_LINK);
    params.disposition = WindowOpenDisposition::kNewForegroundTab;
    Navigate(&params);
  }

  raw_ptr<BrowserWindowInterface> browser_;
  CloseWatcher close_watcher_;
};

BEGIN_METADATA(PerchSidePanelWebView)
END_METADATA

std::map<BrowserWindowInterface*, std::unique_ptr<PerchSidePanelController>>&
Controllers() {
  static base::NoDestructor<std::map<BrowserWindowInterface*,
                                     std::unique_ptr<PerchSidePanelController>>>
      controllers;
  return *controllers;
}

// True the first time it runs for a profile: the toolbar button is pinned
// once, and stays unpinned if the user unpins it.
bool FirstPin(base::FilePath profile_dir) {
  const base::FilePath dir = profile_dir.Append("Perch Agent");
  const base::FilePath marker = dir.Append("sidebar-pinned");
  if (base::PathExists(marker)) {
    return false;
  }
  base::CreateDirectory(dir);
  return base::WriteFile(marker, "1");
}

}  // namespace

PerchSidePanelController::PerchSidePanelController(
    BrowserWindowInterface* browser,
    SidePanelRegistry& registry)
    : browser_(browser),
      registry_(&registry),
      window_id_(base::NumberToString(browser->GetSessionID().id())) {
  auto perch_entry = std::make_unique<SidePanelEntry>(
      PerchKey(),
      base::BindRepeating(&PerchSidePanelController::CreateView,
                          base::Unretained(this)),
      base::BindRepeating([] { return kDefaultWidth; }));
  // The chat draws its own header (title, history, new chat, close), so
  // Chromium's "Perch" header with pin and close would be a second one.
  perch_entry->set_should_show_header(false);
  registry.Register(std::move(perch_entry));
  if (SidePanelEntry* entry = registry.GetEntryForKey(PerchKey())) {
    entry->AddObserver(this);
  }
  browser->GetTabStripModel()->AddObserver(this);
  PinOnce();
  // Once the window is up, a profile whose key needs restoring shows its
  // restore page here.
  base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
      FROM_HERE, base::BindOnce(&PerchSidePanelController::OnWindowReady,
                                weak_factory_.GetWeakPtr()));
}

void PerchSidePanelController::OnWindowReady() {
  KeyBroker::Get().OnWindowOpened(browser_);
}

PerchSidePanelController::~PerchSidePanelController() {
  if (SidePanelEntry* entry = registry_->GetEntryForKey(PerchKey())) {
    entry->RemoveObserver(this);
  }
  registry_->Deregister(PerchKey());
  if (TabStripModel* model = browser_->GetTabStripModel()) {
    model->RemoveObserver(this);
  }
}

namespace {

// Ids of tabs between leaving one window and arriving in another.
std::set<std::string>& MovingTabs() {
  static base::NoDestructor<std::set<std::string>> moving;
  return *moving;
}

}  // namespace

void PerchSidePanelController::OnTabStripModelChanged(
    TabStripModel* tab_strip_model,
    const TabStripModelChange& change,
    const TabStripSelectionChange& selection) {
  Profile* profile = browser_->GetProfile();
  PerchTabSync& sync = PerchTabSync::Get();
  if (change.type() == TabStripModelChange::kRemoved) {
    for (const auto& removed : change.GetRemove()->contents) {
      if (!removed.tab) {
        continue;
      }
      if (removed.tab_detach_reason ==
          tabs::TabInterface::DetachReason::kDelete) {
        sync.Remove(profile, TabIdFor(removed.tab));
        if (IsPerchdConnected()) {
          EmitPerchEvent("tabClosed", base::DictValue().Set(
                                          "tabId", TabIdFor(removed.tab)));
        }
        ForgetTab(removed.tab);
      } else {
        // Leaving for another window: the insert there reports the move.
        MovingTabs().insert(TabIdFor(removed.tab));
      }
    }
  } else if (change.type() == TabStripModelChange::kInserted) {
    for (const auto& inserted : change.GetInsert()->contents) {
      if (inserted.tab) {
        sync.Update(profile, window_id_, inserted.tab);
        const bool moved = MovingTabs().erase(TabIdFor(inserted.tab)) > 0;
        if (IsPerchdConnected()) {
          EmitPerchEvent(moved ? "tabMoved" : "tabCreated",
                         TabInfo(inserted.tab));
        }
      }
    }
  } else if (change.type() == TabStripModelChange::kMoved &&
             IsPerchdConnected()) {
    if (tabs::TabInterface* tab = change.GetMove()->tab) {
      EmitPerchEvent("tabMoved", TabInfo(tab));
    }
  }
  if (!selection.active_tab_changed() || !selection.new_tab) {
    return;
  }
  tabs::TabInterface* tab = selection.new_tab;
  sync.Activate(profile, window_id_, tab);
  SidePanelUI* side_panel = SidePanelUI::From(browser_);
  if (!side_panel) {
    return;
  }
  const bool want = IsPanelOpenFor(tab);
  if (want == IsShowing()) {
    return;
  }
  base::AutoReset<bool> switching(&switching_, true);
  if (want) {
    side_panel->Show(SidePanelEntryId::kPerch,
                     SidePanelOpenTrigger::kTabChanged);
  } else {
    // Without the animation the panel is hidden before `switching` ends, so
    // OnEntryHidden does not clear this tab's remembered state.
    side_panel->Close(SidePanelEntryHideReason::kSidePanelClosed,
                      /*suppress_animations=*/true);
  }
}

void PerchSidePanelController::OnTabChangedAt(tabs::TabInterface* tab,
                                              TabChangeType change_type) {
  if (change_type == TabChangeType::kAll) {
    PerchTabSync::Get().Update(browser_->GetProfile(), window_id_, tab);
    if (IsPerchdConnected()) {
      EmitPerchEvent("tabUpdated", TabInfo(tab));
    }
  }
}

void PerchSidePanelController::OnEntryShown(SidePanelEntry* entry) {
  // Each window keeps its own sidebar width (Chromium keeps one per profile).
  if (width_ > 0) {
    if (SidePanel* panel = Panel()) {
      panel->SetPanelWidth(width_);
    }
  }
  tabs::TabInterface* tab = browser_->GetTabStripModel()->GetActiveTab();
  if (!tab) {
    return;
  }
  if (!switching_) {
    SetPanelOpenFor(tab, true);
  }
  PerchTabSync::Get().ResyncAll(browser_->GetProfile());
}

void PerchSidePanelController::OnEntryHidden(SidePanelEntry* entry) {
  if (SidePanel* panel = Panel(); panel && panel->width() > 0) {
    width_ = panel->width();
  }
  tabs::TabInterface* tab = browser_->GetTabStripModel()->GetActiveTab();
  if (tab && !switching_) {
    SetPanelOpenFor(tab, false);
  }
}

std::unique_ptr<views::View> PerchSidePanelController::CreateView(
    SidePanelEntryScope& scope) {
  PerchdLauncher::Get().MaybeStart();
  const GURL url(std::string(kSideShellURL) + "?window=" + window_id_);
  auto view = std::make_unique<PerchSidePanelWebView>(
      scope, browser_,
      std::make_unique<WebUIContentsWrapperT<PerchSideShellUI>>(
          url, browser_->GetProfile(), IDS_TOOLTIP_SIDE_PANEL,
          /*esc_closes_ui=*/false));
  // The page needs no handshake to be shown.
  view->ShowUI();
  return view;
}

SidePanel* PerchSidePanelController::Panel() const {
  BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
  return view ? view->side_panel() : nullptr;
}

void PerchSidePanelController::PinOnce() {
  Profile* profile = browser_->GetProfile();
  if (!profile->IsRegularProfile()) {
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
      base::BindOnce(&FirstPin, profile->GetPath()),
      base::BindOnce(
          [](base::WeakPtr<Profile> profile, bool first) {
            if (!first || !profile) {
              return;
            }
            if (PinnedToolbarActionsModel* model =
                    PinnedToolbarActionsModel::Get(profile.get())) {
              model->UpdatePinnedState(kActionSidePanelShowPerch, true);
            }
          },
          profile->GetWeakPtr()));
}

bool PerchSidePanelController::IsShowing() const {
  const SidePanelUI* side_panel = SidePanelUI::From(browser_.get());
  return side_panel && side_panel->IsSidePanelEntryShowing(PerchKey());
}

void InitWindowFeatures(BrowserWindowInterface* browser,
                        SidePanelRegistry& registry) {
  if (browser->GetType() != BrowserWindowInterface::TYPE_NORMAL ||
      !browser->GetTabStripModel()) {
    return;
  }
  PerchdLauncher::Get().MaybeStart();
  Controllers()[browser] =
      std::make_unique<PerchSidePanelController>(browser, registry);
  ApplyPerchTheme(browser->GetProfile());
  WatchMemorySaver(browser->GetProfile());
  KeyBroker::Get().EnsureProfile(browser->GetProfile());
  WatchHideChrome(browser);
  AddPerchMenuItems();
  MaybeStartChromeSnapshot(browser);
}

void TearDownWindowFeatures(BrowserWindowInterface* browser) {
  UnwatchHideChrome(browser);
  ForgetCommandBar(browser);
  Controllers().erase(browser);
}

}  // namespace perch
