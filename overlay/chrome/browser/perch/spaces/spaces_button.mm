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

// Space rows, then New Space, Rename Space and Delete Space.
constexpr int kFirstSpace = 1;
constexpr int kNewSpace = 1000;
constexpr int kRenameSpace = 1001;
constexpr int kDeleteSpace = 1002;

// Asks for a new name in a native sheet-less alert.
std::u16string AskForName(const std::u16string& current) {
  NSAlert* alert = [[NSAlert alloc] init];
  alert.messageText = @"Rename Space";
  [alert addButtonWithTitle:@"Rename"];
  [alert addButtonWithTitle:@"Cancel"];
  NSTextField* field =
      [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, 240, 24)];
  field.stringValue = base::SysUTF16ToNSString(current);
  alert.accessoryView = field;
  alert.window.initialFirstResponder = field;
  if ([alert runModal] != NSAlertFirstButtonReturn) {
    return std::u16string();
  }
  return base::SysNSStringToUTF16(field.stringValue);
}

class SpacesMenuModel : public ui::SimpleMenuModel,
                        public ui::SimpleMenuModel::Delegate {
 public:
  explicit SpacesMenuModel(BrowserWindowInterface* browser)
      : ui::SimpleMenuModel(this), browser_(browser) {
    spaces_ = ListSpaces(browser->GetProfile());
    for (size_t i = 0; i < spaces_.size(); ++i) {
      AddCheckItem(kFirstSpace + static_cast<int>(i), spaces_[i].name);
    }
    AddSeparator(ui::NORMAL_SEPARATOR);
    AddItem(kNewSpace, u"New Space");
    AddItem(kRenameSpace, u"Rename Space…");
    AddItem(kDeleteSpace, u"Delete Space");
  }

  bool IsCommandIdChecked(int command_id) const override {
    const size_t row = command_id - kFirstSpace;
    return command_id >= kFirstSpace && row < spaces_.size() &&
           spaces_[row].active;
  }

  bool IsCommandIdEnabled(int command_id) const override {
    return command_id != kDeleteSpace || spaces_.size() > 1;
  }

  void ExecuteCommand(int command_id, int event_flags) override {
    switch (command_id) {
      case kNewSpace:
        NewSpace(browser_);
        return;
      case kRenameSpace: {
        Profile* profile = browser_->GetProfile();
        const std::u16string name = AskForName(ActiveSpaceName(profile));
        if (!name.empty()) {
          RenameActiveSpace(profile, name);
        }
        return;
      }
      case kDeleteSpace:
        DeleteActiveSpace(browser_);
        return;
      default:
        SwitchToSpace(browser_, command_id - kFirstSpace);
    }
  }

 private:
  raw_ptr<BrowserWindowInterface> browser_;
  std::vector<SpaceInfo> spaces_;
};

// The active space as a quiet chip at the start of the tab strip: its name,
// then a chevron icon centred beside it; a press opens the menu.
class SpacesButton : public views::LabelButton {
  METADATA_HEADER(SpacesButton, views::LabelButton)

 public:
  explicit SpacesButton(BrowserWindowInterface* browser)
      : views::LabelButton(
            base::BindRepeating(&SpacesButton::ShowMenu,
                                base::Unretained(this))),
        browser_(browser) {
    label()->SetFontList(gfx::FontList().DeriveWithSizeDelta(
        12 - gfx::FontList().GetFontSize()));
    // The tab strip draws on a see-through layer.
    label()->SetSubpixelRenderingEnabled(false);
    SetEnabledTextColors(kColorTabForegroundInactiveFrameActive);
    // The chevron follows the name and sits on its centre line.
    SetImageModel(views::Button::STATE_NORMAL,
                  ui::ImageModel::FromVectorIcon(
                      vector_icons::kKeyboardArrowDownIcon,
                      kColorTabForegroundInactiveFrameActive, 14));
    SetHorizontalAlignment(gfx::ALIGN_RIGHT);
    SetImageLabelSpacing(2);
    SetBorder(views::CreateEmptyBorder(gfx::Insets::TLBR(0, 8, 0, 4)));
    SetMinSize(gfx::Size(0, 26));
    SetMaxSize(gfx::Size(160, 26));
    // An 8 px rounded fill on hover and press, like the strip's other
    // controls.
    views::InstallRoundRectHighlightPathGenerator(this, gfx::Insets(), 8);
    views::InkDrop::Get(this)->SetMode(views::InkDropHost::InkDropMode::ON);
    views::InkDrop::Get(this)->SetBaseColor(kColorTabForegroundInactiveFrameActive);
    views::InkDrop::Get(this)->SetHighlightOpacity(0.08f);
    views::InkDrop::Get(this)->SetVisibleOpacity(0.12f);
    SetTooltipText(u"Spaces");
    SetProperty(views::kCrossAxisAlignmentKey,
                views::LayoutAlignment::kCenter);
    SetProperty(views::kMarginsKey, gfx::Insets::TLBR(0, 4, 0, 4));
    registrar_.Init(browser->GetProfile()->GetPrefs());
    for (const char* pref : {prefs::kSpaces, prefs::kActiveSpace}) {
      registrar_.Add(pref, base::BindRepeating(&SpacesButton::UpdateName,
                                               base::Unretained(this)));
    }
    UpdateName();
  }

 private:
  void UpdateName() {
    SetText(ActiveSpaceName(browser_->GetProfile()));
  }

  void ShowMenu() {
    model_ = std::make_unique<SpacesMenuModel>(browser_);
    RunToolbarMenu(model_.get(), runner_, this);
  }

  raw_ptr<BrowserWindowInterface> browser_;
  PrefChangeRegistrar registrar_;
  std::unique_ptr<SpacesMenuModel> model_;
  std::unique_ptr<views::MenuRunner> runner_;
};

BEGIN_METADATA(SpacesButton)
END_METADATA

}  // namespace

std::unique_ptr<views::View> CreateSpacesButton(
    BrowserWindowInterface* browser) {
  return std::make_unique<SpacesButton>(browser);
}

}  // namespace perch
