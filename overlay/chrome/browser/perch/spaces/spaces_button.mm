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
#include "chrome/browser/perch/toolbar/perch_profile_menu.h"
#include "components/vector_icons/vector_icons.h"
#include "ui/views/layout/flex_layout_types.h"
#include "ui/views/view_class_properties.h"

namespace perch {

namespace {

// The chevron at the end of the tab strip; a press opens Perch's menu.
class SpacesButton : public views::LabelButton {
  METADATA_HEADER(SpacesButton, views::LabelButton)

 public:
  explicit SpacesButton(BrowserWindowInterface* browser)
      : views::LabelButton(
            base::BindRepeating(&SpacesButton::ShowMenu,
                                base::Unretained(this))),
        browser_(browser) {
    // Just an arrow, so the tabs keep the strip's width; the space's name is
    // in the tooltip and at the top of the menu.
    SetImageModel(views::Button::STATE_NORMAL,
                  ui::ImageModel::FromVectorIcon(
                      vector_icons::kKeyboardArrowDownIcon,
                      kColorTabForegroundInactiveFrameActive, 16));
    SetHorizontalAlignment(gfx::ALIGN_CENTER);
    SetBorder(views::CreateEmptyBorder(gfx::Insets(0)));
    SetMinSize(gfx::Size(28, 28));
    SetMaxSize(gfx::Size(28, 28));
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
    UpdateName();
  }

 private:
  void UpdateName() {
    SetTooltipText(u"Profiles and more");
    GetViewAccessibility().SetName(u"Profiles and more");
  }

  // As on Aside, the chevron opens the profiles and the browser's places
  // (perch_profile_menu.cc). Spaces stay in the menu bar and on ⌃1–⌃9.
  void ShowMenu() { ShowPerchAppMenu(browser_, this); }

  raw_ptr<BrowserWindowInterface> browser_;
};

BEGIN_METADATA(SpacesButton)
END_METADATA

}  // namespace

std::unique_ptr<views::View> CreateSpacesButton(
    BrowserWindowInterface* browser) {
  return std::make_unique<SpacesButton>(browser);
}

}  // namespace perch
