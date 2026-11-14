// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/toolbar/perch_profile_menu.h"
#include "ui/gfx/geometry/insets.h"
#include "components/prefs/pref_service.h"
#include "components/bookmarks/common/bookmark_pref_names.h"

#include <algorithm>

#include "base/no_destructor.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/perch/perch_command_ids.h"
#include "chrome/browser/perch/perch_commands.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_attributes_entry.h"
#include "chrome/browser/profiles/profile_attributes_storage.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile_avatar_icon_util.h"
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
#include "ui/views/animation/ink_drop.h"
#include "ui/views/animation/ink_drop_state.h"
#include "ui/views/view_tracker.h"
#include "ui/views/controls/button/button.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/gfx/vector_icon_types.h"
#include "ui/color/color_id.h"
#include "ui/base/models/image_model.h"
#include "components/vector_icons/vector_icons.h"
#include "chrome/app/vector_icons/vector_icons.h"
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

void NewProfile();

}  // namespace

ui::ImageModel Icon(const gfx::VectorIcon& icon) {
  return ui::ImageModel::FromVectorIcon(icon, ui::kColorMenuIcon, 16);
}

void RunToolbarMenu(ui::MenuModel* model,
                    std::unique_ptr<views::MenuRunner>& runner,
                    views::View* anchor) {
  // A Perch menu drawn by views (frosted, rounded, in Perch's type and
  // tokens) just below the button, not a system NSMenu.
  // The button looks pressed while its menu is open and goes back to rest when
  // it closes. The open menu takes the mouse, so the button never hears the
  // pointer leave; without this its highlight would stay on.
  base::RepeatingClosure on_closed = base::BindRepeating(
      [](views::ViewTracker* tracker) {
        if (auto* button = views::Button::AsButton(tracker->view())) {
          button->SetState(views::Button::STATE_NORMAL);
          if (auto* ink_drop = views::InkDrop::Get(button)) {
            ink_drop->AnimateToState(views::InkDropState::HIDDEN, nullptr);
          }
        }
      },
      base::Owned(std::make_unique<views::ViewTracker>(anchor)));
  runner = std::make_unique<views::MenuRunner>(
      model, views::MenuRunner::HAS_MNEMONICS, std::move(on_closed));
  // Below the whole button, 4px down, lined up with the edge nearer the
  // middle of the window so it never hangs past the window's side.
  gfx::Rect button = anchor->GetAnchorBoundsInScreen();
  button.Inset(gfx::Insets::TLBR(0, 0, -4, 0));
  const gfx::Rect window = anchor->GetWidget()->GetWindowBoundsInScreen();
  const bool right_half = button.CenterPoint().x() > window.CenterPoint().x();
  runner->RunMenuAt(anchor->GetWidget(), nullptr, button,
                    right_half ? views::MenuAnchorPosition::kTopRight
                               : views::MenuAnchorPosition::kTopLeft,
                    ui::mojom::MenuSourceType::kMouse);
  if (auto* pressed = views::Button::AsButton(anchor)) {
    pressed->SetState(views::Button::STATE_PRESSED);
  }
}

PerchProfileMenuModel::PerchProfileMenuModel(BrowserWindowInterface* browser,
                                             Kind kind)
    : ui::SimpleMenuModel(this), browser_(browser), kind_(kind) {
  Build();
}

PerchProfileMenuModel::~PerchProfileMenuModel() = default;

void PerchProfileMenuModel::Build() {
  if (kind_ == Kind::kProfile) {
    BuildProfiles();
  } else {
    BuildApp();
  }
}

// The profile button: who you are, and room for another.
void PerchProfileMenuModel::BuildProfiles() {
  AddTitle(u"Profiles");
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
      // Each profile with its picture, as Aside lists them; the one in this
      // window carries the check.
      AddCheckItem(id, entry->GetName());
      SetIconForCommandId(
          id, ui::ImageModel::FromImage(profiles::GetSizedAvatarIcon(
                  entry->GetAvatarIcon(16), 16, 16, profiles::SHAPE_CIRCLE)));
    }
  }
  AddItemWithIcon(IDC_PERCH_NEW_PROFILE, u"New profile",
                  Icon(vector_icons::kAccountCircleIcon));
  if (kind_ == Kind::kProfile) {
    AddItemWithIcon(IDC_PERCH_MANAGE_PROFILES, u"Manage profiles",
                    Icon(kManageAccountsIcon));
  }
}

// The chevron that ends the tab strip, laid out as Aside's: profiles, then
// the browser's places (bookmarks, downloads, extensions, history, developer
// tools) and Settings, then a new tab or incognito window.
void PerchProfileMenuModel::BuildApp() {
  BuildProfiles();
  AddSeparator(ui::NORMAL_SEPARATOR);

  bookmarks_ = std::make_unique<ui::SimpleMenuModel>(this);
  bookmarks_->AddItem(IDC_BOOKMARK_THIS_TAB, u"Bookmark This Tab");
  bookmarks_->AddCheckItem(IDC_SHOW_BOOKMARK_BAR, u"Always Show Bookmarks Bar");
  bookmarks_->AddItem(IDC_SHOW_BOOKMARK_MANAGER, u"Bookmark Manager");
  AddSubMenuWithIcon(IDC_BOOKMARKS_MENU, u"Bookmarks", bookmarks_.get(),
                     Icon(kBookmarkManagerIcon));

  downloads_menu_ = std::make_unique<ui::SimpleMenuModel>(this);
  AddRecentDownloads();
  downloads_menu_->AddItem(IDC_SHOW_DOWNLOADS, u"Show All Downloads");
  AddSubMenuWithIcon(IDC_PERCH_DOWNLOADS_MENU, u"Downloads",
                     downloads_menu_.get(), Icon(vector_icons::kDownloadIcon));

  extensions_ = std::make_unique<ui::SimpleMenuModel>(this);
  extensions_->AddItem(IDC_MANAGE_EXTENSIONS, u"Manage Extensions");
  extensions_->AddItem(IDC_FIND_EXTENSIONS, u"Get Extensions");
  AddSubMenuWithIcon(IDC_PERCH_EXTENSIONS_MENU, u"Extensions",
                     extensions_.get(),
                     Icon(vector_icons::kExtensionChromeRefreshOldIcon));

  BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
  history_ = std::make_unique<RecentTabsSubMenuModel>(view, browser_);
  AddSubMenuWithIcon(IDC_RECENT_TABS_MENU, u"History",
                     static_cast<ui::SimpleMenuModel*>(history_.get()),
                     Icon(vector_icons::kHistoryIcon));

  // Only the tools Perch keeps (no Customize Chrome, Labs or vertical tabs).
  developers_ = std::make_unique<ui::SimpleMenuModel>(this);
  developers_->AddItem(IDC_DEV_TOOLS, u"Developer Tools");
  if (chrome::CanOpenTaskManager()) {
    developers_->AddItem(IDC_TASK_MANAGER_APP_MENU, u"Task Manager");
  }
  developers_->AddItem(IDC_PERFORMANCE, u"Performance");
  AddSubMenuWithIcon(IDC_PERCH_DEVELOPERS_MENU, u"Developers",
                     developers_.get(), Icon(vector_icons::kCodeIcon));
  AddItemWithIcon(IDC_PERCH_OPEN_SETTINGS, u"Settings",
                  Icon(vector_icons::kSettingsIcon));
  AddSeparator(ui::NORMAL_SEPARATOR);

  AddItemWithIcon(IDC_NEW_TAB, u"New Tab", Icon(kAddIcon));
  AddItemWithIcon(IDC_NEW_INCOGNITO_WINDOW, u"Incognito Window",
                  Icon(kIncognitoIcon));
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
  if (command_id == IDC_SHOW_BOOKMARK_BAR) {
    return browser_->GetProfile()->GetPrefs()->GetBoolean(
        bookmarks::prefs::kShowBookmarkBar);
  }
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
      NewProfile();
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

namespace {

// A new profile opens straight away in a window of its own, as on Aside: no
// picker. Perch's setup and tour were done once for this Mac (the models are
// shared), so its window opens on a new tab.
void NewProfile() {
  ProfileManager* manager = g_browser_process->profile_manager();
  if (!manager) {
    return;
  }
  ProfileAttributesStorage& storage = manager->GetProfileAttributesStorage();
  ProfileManager::CreateMultiProfileAsync(
      storage.ChooseNameForNewProfile(),
      storage.ChooseAvatarIconIndexForNewProfile(), /*is_hidden=*/false,
      base::BindOnce([](Profile* profile) {
        if (!profile) {
          return;
        }
        profile->GetPrefs()->SetBoolean(prefs::kOnboardingFinished, true);
        profile->GetPrefs()->SetBoolean(prefs::kTourFinished, true);
        chrome::NewEmptyWindow(profile);
      }));
}

void ShowMenu(BrowserWindowInterface* browser,
              views::View* anchor,
              PerchProfileMenuModel::Kind kind) {
  OpenMenu& open = Current();
  if (open.runner && open.runner->IsRunning()) {
    open.runner->Cancel();
  }
  open.runner.reset();
  open.model = std::make_unique<PerchProfileMenuModel>(browser, kind);
  RunToolbarMenu(open.model.get(), open.runner, anchor);
}

}  // namespace

void ShowPerchProfileMenu(BrowserWindowInterface* browser,
                          views::View* anchor) {
  ShowMenu(browser, anchor, PerchProfileMenuModel::Kind::kProfile);
}

bool ShowPerchAppMenu(BrowserWindowInterface* browser, views::View* anchor) {
  ShowMenu(browser, anchor, PerchProfileMenuModel::Kind::kApp);
  return true;
}

}  // namespace perch
