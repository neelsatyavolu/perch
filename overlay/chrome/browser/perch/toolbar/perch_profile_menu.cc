// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/toolbar/perch_profile_menu.h"

#include <algorithm>

#include "base/no_destructor.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/perch/perch_command_ids.h"
#include "chrome/browser/perch/perch_commands.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_attributes_entry.h"
#include "chrome/browser/profiles/profile_attributes_storage.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_window.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/profiles/profile_picker.h"
#include "chrome/browser/ui/tabs/recent_tabs_sub_menu_model.h"
#include "chrome/browser/ui/toolbar/app_menu_model.h"
#include "components/download/public/common/download_item.h"
#include "content/public/browser/download_manager.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"

namespace perch {

namespace {

bool IsProfileRow(int command_id) {
  return command_id >= IDC_PERCH_PROFILE_FIRST &&
         command_id <= IDC_PERCH_PROFILE_LAST;
}

// The open menu. One is open at a time; the next one replaces it.
struct OpenMenu {
  std::unique_ptr<PerchProfileMenuModel> model;
  std::unique_ptr<views::MenuRunner> runner;
};

OpenMenu& Current() {
  static base::NoDestructor<OpenMenu> open;
  return *open;
}

}  // namespace

PerchProfileMenuModel::PerchProfileMenuModel(BrowserWindowInterface* browser)
    : ui::SimpleMenuModel(this), browser_(browser) {
  Build();
}

PerchProfileMenuModel::~PerchProfileMenuModel() = default;

void PerchProfileMenuModel::Build() {
  ProfileManager* manager = g_browser_process->profile_manager();
  if (manager) {
    for (ProfileAttributesEntry* entry :
         manager->GetProfileAttributesStorage()
             .GetAllProfilesAttributesSortedForDisplay()) {
      const int id = IDC_PERCH_PROFILE_FIRST + static_cast<int>(profiles_.size());
      if (id > IDC_PERCH_PROFILE_LAST) {
        break;
      }
      profiles_.push_back(entry->GetPath());
      AddCheckItem(id, entry->GetName());
    }
  }
  AddItem(IDC_PERCH_NEW_PROFILE, u"New Profile");
  AddItem(IDC_PERCH_MANAGE_PROFILES, u"Manage Profiles");
  AddSeparator(ui::NORMAL_SEPARATOR);
  bookmarks_ = std::make_unique<ui::SimpleMenuModel>(this);
  bookmarks_->AddItem(IDC_BOOKMARK_THIS_TAB, u"Bookmark This Tab");
  bookmarks_->AddItem(IDC_SHOW_BOOKMARK_BAR, u"Show Bookmarks Bar");
  bookmarks_->AddItem(IDC_SHOW_BOOKMARK_MANAGER, u"Bookmark Manager");
  AddSubMenu(IDC_BOOKMARKS_MENU, u"Bookmarks", bookmarks_.get());

  downloads_menu_ = std::make_unique<ui::SimpleMenuModel>(this);
  AddRecentDownloads();
  downloads_menu_->AddItem(IDC_SHOW_DOWNLOADS, u"Show All Downloads");
  AddSubMenu(IDC_PERCH_DOWNLOADS_MENU, u"Downloads", downloads_menu_.get());

  extensions_ = std::make_unique<ui::SimpleMenuModel>(this);
  extensions_->AddItem(IDC_MANAGE_EXTENSIONS, u"Manage Extensions");
  extensions_->AddItem(IDC_FIND_EXTENSIONS, u"Chrome Web Store");
  AddSubMenu(IDC_PERCH_EXTENSIONS_MENU, u"Extensions", extensions_.get());

  BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
  history_ = std::make_unique<RecentTabsSubMenuModel>(view, browser_);
  AddSubMenu(IDC_RECENT_TABS_MENU, u"History",
             static_cast<ui::SimpleMenuModel*>(history_.get()));
  developers_ = std::make_unique<ToolsMenuModel>(this, browser_);
  AddSubMenu(IDC_PERCH_DEVELOPERS_MENU, u"Developers", developers_.get());
  AddSeparator(ui::NORMAL_SEPARATOR);
  AddItem(IDC_PERCH_OPEN_SETTINGS, u"Settings");
  AddItem(IDC_NEW_TAB, u"New Tab");
  AddItem(IDC_NEW_INCOGNITO_WINDOW, u"Incognito Window");
}

void PerchProfileMenuModel::AddRecentDownloads() {
  content::DownloadManager* manager =
      browser_->GetProfile()->GetDownloadManager();
  if (!manager) {
    return;
  }
  std::vector<raw_ptr<download::DownloadItem, VectorExperimental>> items;
  manager->GetAllDownloads(&items);
  std::erase_if(items, [](const auto& item) {
    return item->GetState() != download::DownloadItem::COMPLETE ||
           item->GetFileExternallyRemoved();
  });
  std::ranges::sort(items, [](const auto& a, const auto& b) {
    return a->GetEndTime() > b->GetEndTime();
  });
  for (const auto& item : items) {
    const int id = IDC_PERCH_DOWNLOAD_FIRST + static_cast<int>(downloads_.size());
    if (id > IDC_PERCH_DOWNLOAD_LAST) {
      break;
    }
    downloads_.push_back(item->GetGuid());
    downloads_menu_->AddItem(id, item->GetFileNameToReportUser().LossyDisplayName());
  }
  if (!downloads_.empty()) {
    downloads_menu_->AddSeparator(ui::NORMAL_SEPARATOR);
  }
}

bool PerchProfileMenuModel::IsCommandIdChecked(int command_id) const {
  if (!IsProfileRow(command_id)) {
    return false;
  }
  const size_t row = command_id - IDC_PERCH_PROFILE_FIRST;
  return row < profiles_.size() &&
         profiles_[row] == browser_->GetProfile()->GetPath();
}

bool PerchProfileMenuModel::IsCommandIdEnabled(int command_id) const {
  if (command_id >= IDC_PERCH_FIRST && command_id <= IDC_PERCH_LAST) {
    return true;
  }
  return chrome::IsCommandEnabled(browser_, command_id);
}

bool PerchProfileMenuModel::GetAcceleratorForCommandId(
    int command_id,
    ui::Accelerator* accelerator) const {
  BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
  return view && view->GetAccelerator(command_id, accelerator);
}

void PerchProfileMenuModel::ExecuteCommand(int command_id, int event_flags) {
  if (IsProfileRow(command_id)) {
    const size_t row = command_id - IDC_PERCH_PROFILE_FIRST;
    if (row < profiles_.size()) {
      profiles::SwitchToProfile(profiles_[row], /*always_create=*/false);
    }
    return;
  }
  if (command_id >= IDC_PERCH_DOWNLOAD_FIRST &&
      command_id <= IDC_PERCH_DOWNLOAD_LAST) {
    const size_t row = command_id - IDC_PERCH_DOWNLOAD_FIRST;
    content::DownloadManager* manager =
        browser_->GetProfile()->GetDownloadManager();
    download::DownloadItem* item =
        manager && row < downloads_.size()
            ? manager->GetDownloadByGuid(downloads_[row])
            : nullptr;
    if (item) {
      item->OpenDownload();
    }
    return;
  }
  switch (command_id) {
    case IDC_PERCH_NEW_PROFILE:
      ProfilePicker::Show(ProfilePicker::Params::FromEntryPoint(
          ProfilePicker::EntryPoint::kProfileMenuAddNewProfile));
      return;
    case IDC_PERCH_MANAGE_PROFILES:
      ProfilePicker::Show(ProfilePicker::Params::FromEntryPoint(
          ProfilePicker::EntryPoint::kProfileMenuManageProfiles));
      return;
    default:
      if (!ExecutePerchCommand(browser_, command_id)) {
        chrome::ExecuteCommand(browser_, command_id);
      }
  }
}

void ShowPerchProfileMenu(BrowserWindowInterface* browser,
                          views::View* anchor) {
  OpenMenu& open = Current();
  if (open.runner && open.runner->IsRunning()) {
    open.runner->Cancel();
  }
  open.runner.reset();
  open.model = std::make_unique<PerchProfileMenuModel>(browser);
  open.runner = std::make_unique<views::MenuRunner>(
      open.model.get(), views::MenuRunner::HAS_MNEMONICS);
  open.runner->RunMenuAt(anchor->GetWidget(), nullptr,
                         anchor->GetAnchorBoundsInScreen(),
                         views::MenuAnchorPosition::kTopRight,
                         ui::mojom::MenuSourceType::kNone);
}

}  // namespace perch
