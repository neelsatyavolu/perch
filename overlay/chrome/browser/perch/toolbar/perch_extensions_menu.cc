// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/toolbar/perch_extensions_menu.h"

#include <algorithm>
#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/i18n/case_conversion.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/app/vector_icons/vector_icons.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/extensions/extension_action_view_model.h"
#include "chrome/browser/ui/toolbar/toolbar_actions_model.h"
#include "chrome/browser/ui/views/controls/hover_button.h"
#include "chrome/browser/ui/views/extensions/extension_action_delegate_desktop.h"
#include "chrome/browser/ui/views/extensions/extensions_menu_item_view.h"
#include "components/vector_icons/vector_icons.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/models/image_model.h"
#include "ui/base/mojom/dialog_button.mojom.h"
#include "ui/color/color_id.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/views/border.h"
#include "ui/views/bubble/bubble_border.h"
#include "ui/views/bubble/bubble_dialog_delegate_view.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/scroll_view.h"
#include "ui/views/controls/separator.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/layout/box_layout_view.h"
#include "ui/views/style/typography.h"
#include "ui/views/view.h"
#include "ui/views/widget/widget.h"

namespace perch {

namespace {

constexpr int kWidth = 320;
constexpr int kMaxListHeight = 420;
constexpr int kCornerRadius = 6;

ui::ImageModel RowIcon(const gfx::VectorIcon& icon) {
  return ui::ImageModel::FromVectorIcon(icon, ui::kColorMenuIcon, 16);
}

// The panel's contents; the bubble around it is made in ShowPerchExtensionsMenu.
class ExtensionsPanel : public views::View,
                        public ToolbarActionsModel::Observer {
  METADATA_HEADER(ExtensionsPanel, views::View)

 public:
  ExtensionsPanel(BrowserWindowInterface* browser,
                  ExtensionsContainer* container,
                  ExtensionsContainerViews* container_views)
      : browser_(browser),
        model_(ToolbarActionsModel::Get(browser->GetProfile())) {
    SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical));

    AddChildView(Command(IDC_MANAGE_EXTENSIONS, u"Manage Extensions",
                         vector_icons::kExtensionChromeRefreshOldIcon));
    AddChildView(
        Command(IDC_FIND_EXTENSIONS, u"Get Extensions", kOpenInNewIcon));
    if (!model_ || model_->action_ids().empty()) {
      return;
    }
    observation_.Observe(model_.get());

    auto* separator = AddChildView(std::make_unique<views::Separator>());
    separator->SetProperty(views::kMarginsKey, gfx::Insets::VH(6, 0));
    separator->SetColorId(ui::kColorMenuSeparator);
    auto* title = AddChildView(std::make_unique<views::Label>(
        u"Installed extensions", views::style::CONTEXT_LABEL,
        views::style::STYLE_SECONDARY));
    title->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    title->SetBorder(views::CreateEmptyBorder(gfx::Insets::TLBR(2, 12, 4, 12)));

    auto list = std::make_unique<views::BoxLayoutView>();
    list->SetOrientation(views::BoxLayout::Orientation::kVertical);
    // The rows' icons line up under the icons of the two commands above.
    list->SetInsideBorderInsets(gfx::Insets::TLBR(0, 10, 0, 6));
    std::vector<std::unique_ptr<ExtensionMenuItemView>> rows;
    for (const std::string& id : model_->action_ids()) {
      std::unique_ptr<ExtensionActionViewModel> action =
          ExtensionActionViewModel::Create(
              id, browser_,
              std::make_unique<ExtensionActionDelegateDesktop>(
                  browser_, container, container_views));
      if (!action) {
        continue;
      }
      rows.push_back(std::make_unique<ExtensionMenuItemView>(
          browser_, std::move(action),
          ToolbarActionsModel::CanShowActionsInToolbar(*browser_)));
    }
    std::ranges::sort(rows, [](const auto& a, const auto& b) {
      return base::i18n::ToLower(a->view_model()->GetActionName()) <
             base::i18n::ToLower(b->view_model()->GetActionName());
    });
    for (auto& row : rows) {
      rows_.push_back(list->AddChildView(std::move(row)));
    }
    UpdatePins();

    auto* scroll = AddChildView(std::make_unique<views::ScrollView>());
    scroll->ClipHeightTo(0, kMaxListHeight);
    scroll->SetDrawOverflowIndicator(false);
    scroll->SetHorizontalScrollBarMode(
        views::ScrollView::ScrollBarMode::kDisabled);
    scroll->SetBackgroundColor(std::nullopt);
    scroll->SetContents(std::move(list));
  }

  // ToolbarActionsModel::Observer: the list is short-lived, so a change to
  // what is installed just closes it; pins update in place.
  void OnToolbarActionAdded(const ToolbarActionsModel::ActionId& id) override {
    Close();
  }
  void OnToolbarActionRemoved(
      const ToolbarActionsModel::ActionId& id) override {
    Close();
  }
  void OnToolbarActionUpdated(
      const ToolbarActionsModel::ActionId& id) override {}
  void OnToolbarModelInitialized() override {}
  void OnToolbarPinnedActionsChanged() override { UpdatePins(); }
  void OnToolbarActionsModelShutdown() override {
    observation_.Reset();
    model_ = nullptr;
  }

  void Close() {
    if (GetWidget()) {
      GetWidget()->Close();
    }
  }

  base::WeakPtr<ExtensionsPanel> AsWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

 private:
  std::unique_ptr<HoverButton> Command(int command,
                                       const std::u16string& label,
                                       const gfx::VectorIcon& icon) {
    return std::make_unique<HoverButton>(
        base::BindRepeating(&ExtensionsPanel::Run, base::Unretained(this),
                            command),
        RowIcon(icon), label);
  }

  void Run(int command) {
    BrowserWindowInterface* browser = browser_;
    Close();
    chrome::ExecuteCommand(browser, command);
  }

  void UpdatePins() {
    if (!model_) {
      return;
    }
    for (ExtensionMenuItemView* row : rows_) {
      const std::string id = row->view_model()->GetId();
      row->UpdatePinButton(model_->IsActionForcePinned(id),
                           model_->IsActionPinned(id));
    }
  }

  raw_ptr<BrowserWindowInterface> browser_;
  raw_ptr<ToolbarActionsModel> model_;
  std::vector<raw_ptr<ExtensionMenuItemView>> rows_;
  base::ScopedObservation<ToolbarActionsModel, ToolbarActionsModel::Observer>
      observation_{this};
  base::WeakPtrFactory<ExtensionsPanel> weak_factory_{this};
};

BEGIN_METADATA(ExtensionsPanel)
END_METADATA

base::WeakPtr<ExtensionsPanel>& Current() {
  static base::NoDestructor<base::WeakPtr<ExtensionsPanel>> open;
  return *open;
}

}  // namespace

bool ShowPerchExtensionsMenu(BrowserWindowInterface* browser,
                             views::View* anchor,
                             ExtensionsContainer* container,
                             ExtensionsContainerViews* container_views) {
  if (Current()) {
    Current()->Close();
    Current().reset();
    return true;
  }
  auto panel =
      std::make_unique<ExtensionsPanel>(browser, container, container_views);
  Current() = panel->AsWeakPtr();
  auto bubble = std::make_unique<views::BubbleDialogDelegate>(
      anchor, views::BubbleBorder::TOP_RIGHT);
  bubble->SetButtons(static_cast<int>(ui::mojom::DialogButton::kNone));
  bubble->SetShowTitle(false);
  bubble->SetShowCloseButton(false);
  bubble->set_margins(gfx::Insets::VH(6, 0));
  bubble->set_fixed_width(kWidth);
  bubble->set_corner_radius(kCornerRadius);
  // The menus' thin tint: bubbles with it get the frosted material behind.
  bubble->SetBackgroundColor(ui::kColorMenuBackground);
  bubble->SetEnableArrowKeyTraversal(true);
  bubble->SetContentsView(std::move(panel));
  views::Widget* widget =
      views::BubbleDialogDelegate::CreateBubbleDeprecated(
          std::move(bubble), views::Widget::InitParams::NATIVE_WIDGET_OWNS_WIDGET);
  widget->Show();
  return true;
}

}  // namespace perch
