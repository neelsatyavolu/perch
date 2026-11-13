// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/toolbar/agent_tabs_button.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/app/vector_icons/vector_icons.h"
#include "chrome/browser/perch/agent/agent_tabs.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/pref_names.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/views/controls/hover_button.h"
#include "chrome/browser/ui/views/toolbar/toolbar_button.h"
#include "ui/gfx/font_list.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/color/color_provider.h"
#include "cc/paint/paint_flags.h"
#include "ui/gfx/canvas.h"
#include "ui/views/controls/image_view.h"
#include "chrome/browser/ui/color/chrome_color_id.h"
#include "components/favicon/content/content_favicon_driver.h"
#include "components/tabs/public/tab_interface.h"
#include "components/vector_icons/vector_icons.h"
#include "content/public/browser/web_contents.h"
#include "skia/ext/image_operations.h"
#include "ui/base/metadata/metadata_header_macros.h"
#include "ui/base/metadata/metadata_impl_macros.h"
#include "ui/base/models/image_model.h"
#include "ui/base/mojom/dialog_button.mojom.h"
#include "ui/color/color_id.h"
#include "ui/gfx/geometry/insets.h"
#include "ui/gfx/image/image.h"
#include "ui/gfx/image/image_skia_operations.h"
#include "ui/views/accessibility/view_accessibility.h"
#include "ui/views/animation/ink_drop.h"
#include "ui/views/bubble/bubble_border.h"
#include "ui/views/bubble/bubble_dialog_delegate_view.h"
#include "ui/views/controls/label.h"
#include "ui/views/controls/scroll_view.h"
#include "ui/views/controls/separator.h"
#include "ui/views/layout/box_layout.h"
#include "ui/views/layout/layout_types.h"
#include "ui/views/style/typography.h"
#include "ui/views/view_class_properties.h"
#include "ui/views/view_tracker.h"
#include "ui/views/widget/widget.h"

namespace perch {

namespace {

constexpr int kWidth = 300;
constexpr int kMaxListHeight = 360;
constexpr int kCornerRadius = 6;
constexpr int kIconSize = 16;

ui::ImageModel IconFor(tabs::TabInterface* tab) {
  content::WebContents* contents = tab->GetContents();
  auto* driver =
      contents ? favicon::ContentFaviconDriver::FromWebContents(contents)
               : nullptr;
  gfx::Image favicon = driver ? driver->GetFavicon() : gfx::Image();
  if (!favicon.IsEmpty()) {
    return ui::ImageModel::FromImageSkia(
        gfx::ImageSkiaOperations::CreateResizedImage(
            *favicon.ToImageSkia(), skia::ImageOperations::RESIZE_BEST,
            gfx::Size(kIconSize, kIconSize)));
  }
  return ui::ImageModel::FromVectorIcon(vector_icons::kGlobeIcon,
                                        ui::kColorMenuIcon, kIconSize);
}

std::u16string TitleOf(tabs::TabInterface* tab) {
  content::WebContents* contents = tab->GetContents();
  if (!contents) {
    return u"Untitled";
  }
  std::u16string title = contents->GetTitle();
  return title.empty() ? base::UTF8ToUTF16(contents->GetVisibleURL().spec())
                       : title;
}

// The list the button opens; the bubble around it is made in Toggle below.
class AgentTabsPanel : public views::View, public AgentTabsObserver {
  METADATA_HEADER(AgentTabsPanel, views::View)

 public:
  explicit AgentTabsPanel(BrowserWindowInterface* browser) : browser_(browser) {
    SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical));
    auto* title = AddChildView(std::make_unique<views::Label>(
        u"Agent Tabs", views::style::CONTEXT_LABEL,
        views::style::STYLE_PRIMARY));
    title->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    title->SetBorder(views::CreateEmptyBorder(gfx::Insets::TLBR(4, 16, 0, 16)));
    auto* note = AddChildView(std::make_unique<views::Label>(
        u"Background tabs opened for work", views::style::CONTEXT_LABEL,
        views::style::STYLE_SECONDARY));
    note->SetHorizontalAlignment(gfx::ALIGN_LEFT);
    note->SetBorder(views::CreateEmptyBorder(gfx::Insets::TLBR(0, 16, 6, 16)));
    AddSeparator();

    auto list = std::make_unique<views::View>();
    list->SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kVertical));
    for (tabs::TabInterface* tab :
         AgentTabsFor(browser_->GetProfile()->GetOriginalProfile())) {
      auto row = std::make_unique<HoverButton>(
          base::BindRepeating(&AgentTabsPanel::Show, base::Unretained(this),
                              tab->GetWeakPtr()),
          IconFor(tab), TitleOf(tab));
      row->SetTooltipText(TitleOf(tab));
      list->AddChildView(std::move(row));
    }
    auto* scroll = AddChildView(std::make_unique<views::ScrollView>());
    scroll->ClipHeightTo(0, kMaxListHeight);
    scroll->SetDrawOverflowIndicator(false);
    scroll->SetHorizontalScrollBarMode(
        views::ScrollView::ScrollBarMode::kDisabled);
    scroll->SetBackgroundColor(std::nullopt);
    scroll->SetContents(std::move(list));

    AddSeparator();
    AddChildView(std::make_unique<HoverButton>(
        base::BindRepeating(&AgentTabsPanel::CloseAll, base::Unretained(this)),
        ui::ImageModel::FromVectorIcon(vector_icons::kCloseIcon,
                                       ui::kColorMenuIcon, kIconSize),
        u"Close all"));
    AddAgentTabsObserver(this);
  }
  AgentTabsPanel(const AgentTabsPanel&) = delete;
  AgentTabsPanel& operator=(const AgentTabsPanel&) = delete;
  ~AgentTabsPanel() override { RemoveAgentTabsObserver(this); }

  // AgentTabsObserver: the list is short-lived; a change just closes it.
  void OnAgentTabsChanged() override {
    if (!acting_) {
      Close();
    }
  }

  void Close() {
    if (GetWidget()) {
      GetWidget()->Close();
    }
  }

  base::WeakPtr<AgentTabsPanel> AsWeakPtr() {
    return weak_factory_.GetWeakPtr();
  }

 private:
  void AddSeparator() {
    auto* separator = AddChildView(std::make_unique<views::Separator>());
    separator->SetProperty(views::kMarginsKey, gfx::Insets::VH(6, 0));
    separator->SetColorId(ui::kColorMenuSeparator);
  }

  void Show(base::WeakPtr<tabs::TabInterface> tab) {
    acting_ = true;
    if (tab) {
      ShowAgentTab(tab.get(), browser_);
    }
    Close();
  }

  void CloseAll() {
    acting_ = true;
    CloseAgentTabs(browser_->GetProfile()->GetOriginalProfile());
    Close();
  }

  raw_ptr<BrowserWindowInterface> browser_;
  bool acting_ = false;
  base::WeakPtrFactory<AgentTabsPanel> weak_factory_{this};
};

BEGIN_METADATA(AgentTabsPanel)
END_METADATA

base::WeakPtr<AgentTabsPanel>& Current() {
  static base::NoDestructor<base::WeakPtr<AgentTabsPanel>> open;
  return *open;
}

void Toggle(BrowserWindowInterface* browser, views::View* anchor) {
  if (Current()) {
    Current()->Close();
    Current().reset();
    return;
  }
  auto panel = std::make_unique<AgentTabsPanel>(browser);
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
  // The button rests again when the panel closes (as the extensions menu does).
  bubble->RegisterWindowClosingCallback(base::BindOnce(
      [](views::ViewTracker* tracker) {
        if (auto* button = views::Button::AsButton(tracker->view())) {
          button->SetState(views::Button::STATE_NORMAL);
          if (auto* ink_drop = views::InkDrop::Get(button)) {
            ink_drop->AnimateToState(views::InkDropState::HIDDEN, nullptr);
          }
        }
      },
      base::Owned(std::make_unique<views::ViewTracker>(anchor))));
  views::BubbleDialogDelegate::CreateBubbleDeprecated(
      std::move(bubble), views::Widget::InitParams::NATIVE_WIDGET_OWNS_WIDGET)
      ->Show();
}

std::vector<raw_ptr<views::View>>& Buttons() {
  static base::NoDestructor<std::vector<raw_ptr<views::View>>> buttons;
  return *buttons;
}

// An outlined pill, like Ask Perch's shape: the icon, "Agent Tabs" in the
// strip's text colour, then the count dimmer. A faint fill on hover.
class AgentTabsButton : public views::Button, public AgentTabsObserver {
  METADATA_HEADER(AgentTabsButton, views::Button)

 public:
  AgentTabsButton(BrowserWindowInterface* browser, AgentTabsPlacement placement)
      : views::Button(base::BindRepeating(&AgentTabsButton::Pressed,
                                          base::Unretained(this))),
        browser_(browser),
        placement_(placement) {
    auto* layout = SetLayoutManager(std::make_unique<views::BoxLayout>(
        views::BoxLayout::Orientation::kHorizontal,
        gfx::Insets::TLBR(0, 9, 0, 11), 6));
    layout->set_cross_axis_alignment(
        views::BoxLayout::CrossAxisAlignment::kCenter);
    icon_ = AddChildView(std::make_unique<views::ImageView>());
    label_ = AddChildView(std::make_unique<views::Label>(u"Agent Tabs"));
    count_ = AddChildView(std::make_unique<views::Label>());
    for (views::Label* label : {label_.get(), count_.get()}) {
      label->SetAutoColorReadabilityEnabled(false);
      label->SetCanProcessEventsWithinSubtree(false);
    }
    icon_->SetCanProcessEventsWithinSubtree(false);
    count_->SetFontList(count_->font_list().DeriveWithWeight(
        gfx::Font::Weight::NORMAL));
    SetTooltipText(u"Tabs agents opened for their work");
    SetFocusBehavior(FocusBehavior::ACCESSIBLE_ONLY);
    // Centered in the strip's row, clear of the Spaces arrow beside it.
    SetProperty(views::kMarginsKey, gfx::Insets::TLBR(0, 4, 0, 4));
    SetProperty(views::kCrossAxisAlignmentKey, views::LayoutAlignment::kCenter);
    AddAgentTabsObserver(this);
    Buttons().push_back(this);
    // Vertical tabs move it between the tab strip and the toolbar.
    prefs_.Init(browser->GetProfile()->GetPrefs());
    prefs_.Add(prefs::kVerticalTabsEnabled,
               base::BindRepeating(&AgentTabsButton::Update,
                                   base::Unretained(this)));
    Update();
  }
  AgentTabsButton(const AgentTabsButton&) = delete;
  AgentTabsButton& operator=(const AgentTabsButton&) = delete;
  ~AgentTabsButton() override {
    RemoveAgentTabsObserver(this);
    std::erase(Buttons(), this);
  }

  BrowserWindowInterface* browser() const { return browser_; }

  // AgentTabsObserver:
  void OnAgentTabsChanged() override { Update(); }

  // views::View:
  gfx::Size CalculatePreferredSize(
      const views::SizeBounds& available_size) const override {
    gfx::Size size = views::Button::CalculatePreferredSize(available_size);
    size.set_height(kHeight);
    return size;
  }
  void OnThemeChanged() override {
    views::Button::OnThemeChanged();
    const ui::ColorProvider* colors = GetColorProvider();
    foreground_ = colors->GetColor(placement_ == AgentTabsPlacement::kTabStrip
                                       ? kColorTabForegroundInactiveFrameActive
                                       : kColorToolbarButtonIcon);
    icon_->SetImage(ui::ImageModel::FromVectorIcon(kTabIcon, foreground_, 14));
    label_->SetEnabledColor(foreground_);
    count_->SetEnabledColor(SkColorSetA(foreground_, 0x99));
    SchedulePaint();
  }
  void OnPaintBackground(gfx::Canvas* canvas) override {
    gfx::RectF bounds(GetLocalBounds());
    bounds.Inset(0.5f);
    const float radius = bounds.height() / 2;
    const ButtonState state = GetState();
    if (state == STATE_HOVERED || state == STATE_PRESSED) {
      cc::PaintFlags fill;
      fill.setAntiAlias(true);
      fill.setColor(SkColorSetA(foreground_,
                                state == STATE_PRESSED ? 0x24 : 0x14));
      canvas->DrawRoundRect(bounds, radius, fill);
    }
    cc::PaintFlags stroke;
    stroke.setAntiAlias(true);
    stroke.setStyle(cc::PaintFlags::kStroke_Style);
    stroke.setStrokeWidth(1);
    stroke.setColor(SkColorSetA(foreground_, 0x40));
    canvas->DrawRoundRect(bounds, radius, stroke);
  }
  void StateChanged(ButtonState old_state) override {
    views::Button::StateChanged(old_state);
    SchedulePaint();
  }

 private:
  static constexpr int kHeight = 26;

  void Pressed() { Toggle(browser_, this); }

  void Update() {
    const size_t count =
        AgentTabsFor(browser_->GetProfile()->GetOriginalProfile()).size();
    const bool vertical =
        browser_->GetProfile()->GetPrefs()->GetBoolean(
            prefs::kVerticalTabsEnabled);
    const bool here = (placement_ == AgentTabsPlacement::kToolbar) == vertical;
    SetVisible(count > 0 && here);
    const std::u16string number = base::NumberToString16(count);
    if (count_->GetText() != number) {
      count_->SetText(number);
      GetViewAccessibility().SetName(
          count == 1 ? u"Agent Tabs, 1 tab" : u"Agent Tabs, " + number + u" tabs");
      PreferredSizeChanged();
    }
  }

  raw_ptr<BrowserWindowInterface> browser_;
  const AgentTabsPlacement placement_;
  raw_ptr<views::ImageView> icon_;
  raw_ptr<views::Label> label_;
  raw_ptr<views::Label> count_;
  SkColor foreground_ = SK_ColorWHITE;
  PrefChangeRegistrar prefs_;
};

BEGIN_METADATA(AgentTabsButton)
END_METADATA

}  // namespace

void OpenAgentTabsMenuForSnapshot(BrowserWindowInterface* browser) {
  for (views::View* view : Buttons()) {
    if (static_cast<AgentTabsButton*>(view)->browser() == browser &&
        view->GetVisible()) {
      Toggle(browser, view);
      return;
    }
  }
}

views::Widget* GetAgentTabsMenuWidget() {
  return Current() ? Current()->GetWidget() : nullptr;
}

std::unique_ptr<views::View> CreateAgentTabsButton(
    BrowserWindowInterface* browser,
    AgentTabsPlacement placement) {
  return std::make_unique<AgentTabsButton>(browser, placement);
}

}  // namespace perch
