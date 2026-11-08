// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/toolbar/perch_profile_menu.h"

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
#include "chrome/browser/ui/toolbar/app_menu_model.h"
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
  AddItem(IDC_SHOW_BOOKMARK_MANAGER, u"Bookmarks");
  AddItem(IDC_SHOW_DOWNLOADS, u"Downloads");
  AddItem(IDC_MANAGE_EXTENSIONS, u"Extensions");
  AddItem(IDC_SHOW_HISTORY, u"History");
  developers_ = std::make_unique<ToolsMenuModel>(this, browser_);
  AddSubMenu(IDC_PERCH_DEVELOPERS_MENU, u"Developers", developers_.get());
  AddSeparator(ui::NORMAL_SEPARATOR);
  AddItem(IDC_PERCH_OPEN_SETTINGS, u"Settings");
  AddItem(IDC_NEW_TAB, u"New Tab");
  AddItem(IDC_NEW_INCOGNITO_WINDOW, u"Incognito Window");
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
