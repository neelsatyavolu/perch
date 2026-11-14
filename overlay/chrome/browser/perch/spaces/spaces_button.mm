// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#import <AppKit/AppKit.h>

#include <memory>
#include <vector>

#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/strings/sys_string_conversions.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/spaces/spaces.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/color/chrome_color_id.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/mojom/menu_source_type.mojom.h"
#include "ui/gfx/font_list.h"
#include "ui/menus/simple_menu_model.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/controls/button/label_button.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/menu/menu_runner.h"
#include "ui/base/models/image_model.h"
#include "ui/views/border.h"
#include "ui/views/controls/highlight_path_generator.h"
#include "ui/views/animation/ink_drop.h"
#include "base/scoped_observation.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/perch/toolbar/perch_profile_menu.h"
#include "chrome/browser/profiles/profile_attributes_entry.h"
#include "chrome/browser/profiles/profile_attributes_storage.h"
#include "chrome/browser/profiles/profile_avatar_icon_util.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "ui/views/controls/image_view.h"
#include "ui/views/layout/box_layout.h"
#include "components/vector_icons/vector_icons.h"
#include "ui/views/layout/flex_layout_types.h"
#include "ui/views/view_class_properties.h"

namespace perch {

namespace {

// The end of the tab strip, as on Aside: this profile's icon, then a chevron;
// a press opens Perch's menu (perch_profile_menu.cc). Spaces stay in the menu
// bar and on Control-1 to 9.
class SpacesButton : public views::Button,
                     public ProfileAttributesStorage::Observer {
  METADATA_HEADER(SpacesButton, views::Button)

 public:
  explicit SpacesButton(BrowserWindowInterface* browser)
      : views::Button(base::BindRepeating(&SpacesButton::ShowMenu,
                                          base::Unretained(this))),
        browser_(browser) {
    auto* layout = SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal, gfx::Insets::VH(0, 5), 2));
    layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kCenter);
    avatar_ = AddChildView(std::make_unique<views::ImageView>());
    avatar_->SetCanProcessEventsWithinSubtree(false);
    auto* chevron = AddChildView(std::make_unique<views::ImageView>(
        ui::ImageModel::FromVectorIcon(vector_icons::kKeyboardArrowDownIcon,
                                       kColorTabForegroundInactiveFrameActive,
                                       14)));
    chevron->SetCanProcessEventsWithinSubtree(false);
    SetPreferredSize(gfx::Size(46, 28));
    // A 4 px rounded fill on hover and press, like the strip's other
    // controls.
    views::InstallRoundRectHighlightPathGenerator(this, gfx::Insets(), 4);
    views::InkDrop::Get(this)->SetMode(
        views::InkDropHost::InkDropMode::ON_NO_ANIMATE);
    views::InkDrop::Get(this)->SetBaseColor(
        kColorTabForegroundActiveFrameActive);
    views::InkDrop::Get(this)->SetHighlightOpacity(0.08f);
    views::InkDrop::Get(this)->SetVisibleOpacity(0.12f);
    SetProperty(views::kCrossAxisAlignmentKey,
                views::LayoutAlignment::kCenter);
    SetProperty(views::kMarginsKey, gfx::Insets::TLBR(0, 4, 0, 8));
    if (ProfileManager* manager = g_browser_process->profile_manager()) {
      observation_.Observe(&manager->GetProfileAttributesStorage());
    }
    Update();
  }

  // ProfileAttributesStorage::Observer:
  void OnProfileAvatarChanged(const base::FilePath& path) override {
    Update();
  }
  void OnProfileHighResAvatarLoaded(const base::FilePath& path) override {
    Update();
  }
  void OnProfileNameChanged(const base::FilePath& path,
                            const std::u16string& old_name) override {
    Update();
  }

 private:
  void Update() {
    ProfileManager* manager = g_browser_process->profile_manager();
    ProfileAttributesEntry* entry =
        manager ? manager->GetProfileAttributesStorage()
                      .GetProfileAttributesWithPath(
                          browser_->GetProfile()->GetOriginalProfile()
                              ->GetPath())
                : nullptr;
    if (entry) {
      avatar_->SetImage(ui::ImageModel::FromImage(profiles::GetSizedAvatarIcon(
          entry->GetAvatarIcon(18), 18, 18, profiles::SHAPE_CIRCLE)));
    }
    const std::u16string name =
        entry ? entry->GetName() + u": profiles and more" : u"Profiles and more";
    SetTooltipText(name);
    GetViewAccessibility().SetName(name);
  }

  void ShowMenu() { ShowPerchAppMenu(browser_, this); }

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<views::ImageView> avatar_ = nullptr;
  base::ScopedObservation<ProfileAttributesStorage,
                          ProfileAttributesStorage::Observer>
      observation_{this};
};

BEGIN_METADATA(SpacesButton)
END_METADATA

}  // namespace

std::unique_ptr<views::View> CreateSpacesButton(
    BrowserWindowInterface* browser) {
  return std::make_unique<SpacesButton>(browser);
}

}  // namespace perch
