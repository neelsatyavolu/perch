// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/theme/perch_theme.h"

#include <initializer_list>
#include <memory>
#include <string>

#include "base/functional/bind.h"
#include "base/memory/raw_ptr.h"
#include "base/no_destructor.h"
#include "base/supports_user_data.h"
#include "chrome/browser/perch/layout/perch_layout.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/color/chrome_color_id.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/color/color_id.h"
#include "ui/color/color_mixer.h"
#include "ui/color/color_provider.h"
#include "ui/color/color_provider_key.h"
#include "ui/color/color_provider_manager.h"
#include "ui/color/color_recipe.h"
#include "ui/color/color_transform.h"
#include "ui/native_theme/native_theme.h"

namespace perch {

namespace {

#include "chrome/browser/perch/theme/perch_tokens.inc"

constexpr char kWatcherKey[] = "perch.theme";

// What the window shows now: the last profile whose settings changed. Perch
// has one appearance per profile, and most people use one profile.
struct Appearance {
  std::string theme = "ink";
  std::string accent = "blue";
  bool match_system = false;
  std::string dark_theme = "ink";
};

Appearance& Current() {
  static base::NoDestructor<Appearance> current;
  return *current;
}

SkColor Mix(SkColor top, SkColor base, float amount) {
  auto channel = [&](int shift) {
    const int t = (top >> shift) & 0xFF;
    const int b = (base >> shift) & 0xFF;
    return static_cast<SkColor>(b + (t - b) * amount) << shift;
  };
  return 0xFF000000 | channel(16) | channel(8) | channel(0);
}

// A hairline drawn over `base`, as one opaque colour.
SkColor Over(SkColor line, SkColor base) {
  return Mix(line | 0xFF000000, base, SkColorGetA(line) / 255.0f);
}

void AddPerchMixer(ui::ColorProvider* provider,
                   const ui::ColorProviderKey& key) {
  // A theme from the Chrome Web Store wins, as do forced colours.
  if (key.custom_theme ||
      key.forced_colors != ui::ColorProviderKey::ForcedColors::kNone) {
    return;
  }
  const Appearance& now = Current();
  std::string name = now.theme;
  if (now.match_system) {
    name = key.color_mode == ui::ColorProviderKey::ColorMode::kDark
               ? now.dark_theme
               : std::string("paper");
  }
  // Incognito windows (ThemeService gives them a grayscale key): Graphite
  // with the mono accent, so a private window looks different at a glance.
  const bool incognito =
      key.user_color_source ==
      ui::ColorProviderKey::UserColorSource::kGrayscale;
  if (incognito) {
    name = "graphite";
  }
  if (key.contrast_mode == ui::ColorProviderKey::ContrastMode::kHigh) {
    name = "contrast";
  }
  const PerchThemeTokens* t = FindPerchTheme(name);
  const PerchAccentTokens* a =
      FindPerchAccent(incognito ? std::string("mono") : now.accent);
  if (!t || !a) {
    return;
  }
  const SkColor accent = t->dark ? a->on_dark : a->on_paper;
  const SkColor hair = Over(t->hair, t->canvas);
  const SkColor body = Over(t->body, t->card);
  const SkColor tint = Mix(accent, t->raised, t->dark ? 0.22f : 0.10f);
  // Errors: DESIGN.md's danger, which holds 4.5:1 on each theme's card.
  const SkColor danger = t->dark ? SkColorSetRGB(0xEE, 0x5A, 0x4B)
                                 : SkColorSetRGB(0xBC, 0x2E, 0x23);

  ui::ColorMixer& m = provider->AddMixer();
  // Raised: the tab strip and the frame around it, a step off the toolbar so
  // the active tab reads as part of the toolbar.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{ui::kColorFrameActive, ui::kColorFrameInactive,
                         kColorTabBackgroundInactiveFrameActive,
                         kColorTabBackgroundInactiveFrameInactive,
                         kColorNewTabButtonBackgroundFrameActive,
                         kColorNewTabButtonBackgroundFrameInactive,
                         kColorNewTabButtonCRBackgroundFrameActive,
                         kColorNewTabButtonCRBackgroundFrameInactive}) {
    m[id] = {t->raised};
  }
  // Canvas: the active tab and the toolbar are one piece, with no line or
  // outline between them, and the address bar is plain text on it until it
  // is hovered.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorTabBackgroundActiveFrameActive,
                         kColorTabBackgroundActiveFrameInactive,
                         kColorTabStrokeFrameActive,
                         kColorTabStrokeFrameInactive,
                         kColorToolbar, kColorBookmarkBarBackground,
                         kColorToolbarTopSeparatorFrameActive,
                         kColorToolbarTopSeparatorFrameInactive,
                         kColorLocationBarBackground,
                         kColorLocationBarBorderOpaque}) {
    m[id] = {t->canvas};
  }
  // Card: the tab hover card.
  m[kColorTabHoverCardBackground] = {t->card};
  // Hover fills the field with the same raised step as focus, so focusing a
  // hovered field only adds the accent ring and never darkens it.
  m[kColorLocationBarBackgroundHovered] = {t->raised};
  m[kColorLocationBarBorder] = {SK_ColorTRANSPARENT};
  // The site controls icon is a plain icon, with no chip behind it.
  m[kColorOmniboxIconBackground] = {SK_ColorTRANSPARENT};
  // The Ask Perch pill.
  m[kColorToolbarButtonBackgroundHighlightedDefault] = {t->raised};
  // Text and icons.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorTabForegroundActiveFrameActive,
        kColorTabForegroundActiveFrameInactive, kColorOmniboxText,
        kColorBookmarkBarForeground}) {
    m[id] = {t->ink};
  }
  m[kColorToolbarButtonIcon] = {body};
  // Inactive tabs keep the mute colour in a background window too: dimming
  // it further dropped their titles below 4.5:1 on the strip.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorTabForegroundInactiveFrameActive,
                         kColorTabForegroundInactiveFrameInactive,
                         kColorOmniboxTextDimmed,
                         kColorToolbarButtonIconInactive}) {
    m[id] = {t->mute};
  }
  // Hairlines.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorToolbarSeparator,
        kColorToolbarContentAreaSeparator}) {
    m[id] = {hair};
  }
  // The dividers between inactive tabs sit on the raised strip, so the
  // hairline is composited onto that, not the canvas, or it disappears.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           kColorTabDividerFrameActive, kColorTabDividerFrameInactive}) {
    m[id] = {Over(t->hair, t->raised)};
  }
  // The accent: focus rings, text selection and the app menu's highlight.
  m[ui::kColorFocusableBorderFocused] = {accent};
  m[ui::kColorTextSelectionBackground] = {tint};
  m[kColorAppMenuHighlightDefault] = {accent};
  m[kColorOmniboxKeywordSelected] = {accent};

  // Tabs that are hovered or picked for a multi-tab action step up from the
  // raised strip they sit on; Chromium's own selection blue doesn't belong in
  // a Perch theme. (A hairline over the canvas came out within 1-6 levels of
  // the strip in Ink, Graphite and Dusk, so hover showed nothing.)
  const SkColor tab_hover = Over(t->hair, t->raised);
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           kColorTabBackgroundInactiveHoverFrameActive,
           kColorTabBackgroundInactiveHoverFrameInactive}) {
    m[id] = {tab_hover};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           kColorTabBackgroundSelectedFrameActive,
           kColorTabBackgroundSelectedFrameInactive,
           kColorTabBackgroundSelectedHoverFrameActive,
           kColorTabBackgroundSelectedHoverFrameInactive}) {
    m[id] = {tab_hover};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           kColorTabForegroundInactiveHoverFrameActive,
           kColorTabForegroundInactiveHoverFrameInactive}) {
    m[id] = {body};
  }

  // The address bar's suggestions: an elevated surface, rows that step up on
  // hover and selection, ink and mute text, and URLs in mute.
  const SkColor row_hover = Over(t->hair, t->raised);
  const SkColor row_selected = Over(t->hair, t->raised);
  m[kColorOmniboxResultsBackground] = {t->raised};
  m[kColorOmniboxResultsBackgroundHovered] = {row_hover};
  m[kColorOmniboxResultsBackgroundSelected] = {row_selected};
  m[kColorOmniboxResultsFocusIndicator] = {accent};
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           kColorOmniboxResultsTextSelected, kColorOmniboxSelectionForeground}) {
    m[id] = {t->ink};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           kColorOmniboxResultsTextDimmed, kColorOmniboxResultsTextDimmedSelected,
           kColorOmniboxResultsTextSecondary,
           kColorOmniboxResultsTextSecondarySelected, kColorOmniboxResultsIcon,
           kColorOmniboxResultsIconHovered,
           kColorOmniboxResultsIconSelected, kColorOmniboxResultsButtonIcon,
           kColorOmniboxResultsButtonIconSelected}) {
    m[id] = {t->mute};
  }
  m[kColorOmniboxResultsUrl] = {t->mute};
  m[kColorOmniboxResultsUrlSelected] = {t->mute};
  m[kColorOmniboxSelectionBackground] = {tint};

  // Chromium's Material system colours, which its bubbles, dialogs, menus
  // and own pages (history, downloads, extensions, settings) all derive
  // from: Perch's tokens, so every surface is one design.
  const SkColor hair_on_card = Over(t->hair, t->card);
  const SkColor strong_on_card = Over(t->hair_strong, t->card);
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysBase, ui::kColorSysHeader, ui::kColorSysHeaderInactive}) {
    m[id] = {t->canvas};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysSurface, ui::kColorSysSurfaceContainerLowest,
           ui::kColorSysSurfaceContainerLow, ui::kColorSysBaseContainer,
           ui::kColorSysHeaderContainer, ui::kColorSysHeaderContainerInactive,
           ui::kColorSysSurfaceSection}) {
    m[id] = {t->card};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysSurfaceContainer, ui::kColorSysSurfaceContainerHigh,
           ui::kColorSysSurfaceContainerHighest, ui::kColorSysSurfaceVariant,
           ui::kColorSysBaseContainerElevated, ui::kColorSysNeutralContainer,
           ui::kColorSysSecondaryContainer, ui::kColorSysOmniboxContainer,
           ui::kColorSysBaseContainerOnSurface}) {
    m[id] = {t->raised};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysOnSurface, ui::kColorSysOnHeaderPrimary,
           ui::kColorSysOnHeaderPrimaryInactive,
           ui::kColorSysOnSecondaryContainer, ui::kColorSysOnPrimaryContainer,
           ui::kColorSysOnTonalContainer, ui::kColorSysOnBaseTonalContainer,
           ui::kColorSysOnSurfacePrimary}) {
    m[id] = {t->ink};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysOnSurfaceSecondary, ui::kColorSysOnSurfaceVariant,
           ui::kColorSysOnSurfacePrimaryInactive}) {
    m[id] = {body};
  }
  m[ui::kColorSysOnSurfaceSubtle] = {Over(t->mute, t->card)};
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysDivider, ui::kColorSysNeutralOutline,
           ui::kColorSysTonalOutline, ui::kColorSysOnHeaderDivider,
           ui::kColorSysOnHeaderDividerInactive}) {
    m[id] = {hair_on_card};
  }
  m[ui::kColorSysOutline] = {strong_on_card};
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysPrimary, ui::kColorSysStateFocusRing,
           ui::kColorSysGradientPrimary}) {
    m[id] = {accent};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysStateTextHighlight}) {
    m[id] = {tint};
  }
  // Tonal containers are surfaces, not the accent (DESIGN.md: accent sparingly).
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysPrimaryContainer, ui::kColorSysTonalContainer,
           ui::kColorSysBaseTonalContainer}) {
    m[id] = {t->raised};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysStateHover, ui::kColorSysStateHoverOnSubtle,
           ui::kColorSysStateHeaderHover, ui::kColorSysStateHeaderHoverInactive}) {
    m[id] = {t->hair};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorSysStatePressed, ui::kColorSysStateHeaderSelect}) {
    m[id] = {t->hair_strong};
  }

  // Prominent buttons use the theme's own button colours (an off-white on
  // dark themes), not Material blue; menus and bubbles sit on the raised and
  // card surfaces with hairline edges.
  m[ui::kColorButtonBackgroundProminent] = {t->button_bg};
  m[ui::kColorButtonForegroundProminent] = {t->button_fg};
  m[ui::kColorButtonBorder] = {strong_on_card};
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           ui::kColorDialogBackground, ui::kColorBubbleBackground,
           ui::kColorBubbleFooterBackground}) {
    m[id] = {t->card};
  }
  m[ui::kColorBubbleBorder] = {strong_on_card};
  // Menus are frosted glass: the macOS menu material shows through a thin
  // Perch tint, with ink-tinted rows, separators and a hairline edge.
  m[ui::kColorMenuBackground] = {SkColorSetA(t->raised, 0x21)};
  m[ui::kColorMenuItemBackgroundHighlighted] = {SkColorSetA(t->ink, 0x1A)};
  m[ui::kColorMenuSeparator] = {SkColorSetA(t->ink, 0x14)};
  m[ui::kColorMenuBorder] = {SkColorSetA(t->ink, 0x1F)};

  // The surface audit (2026-11-08): buttons, switches, checkboxes, badges,
  // errors, toasts, promos, tab details, popup chips, the sidebar and split
  // view in Perch's tokens instead of Material's.
  m[ui::kColorSysOnPrimary] = {t->button_fg};
  m[ui::kColorButtonForeground] = {t->ink};
  m[ui::kColorButtonBackground] = {t->card};
  m[ui::kColorButtonBackgroundTonal] = {t->raised};
  m[ui::kColorButtonBackgroundTonalFocused] = {t->raised};
  m[ui::kColorButtonForegroundTonal] = {t->ink};
  m[ui::kColorSysStateHoverOnProminent] = {SkColorSetA(t->button_fg, 0x14)};
  m[ui::kColorToggleButtonTrackOn] = {t->button_bg};
  m[ui::kColorToggleButtonThumbOn] = {t->button_fg};
  m[ui::kColorToggleButtonThumbOnHover] = {t->button_fg};
  m[ui::kColorToggleButtonTrackOff] = {t->raised};
  m[ui::kColorToggleButtonThumbOff] = {t->mute};
  m[ui::kColorCheckboxContainer] = {t->button_bg};
  m[ui::kColorCheckboxForegroundChecked] = {t->button_bg};
  m[ui::kColorCheckboxCheck] = {t->button_fg};
  m[ui::kColorRadioButtonForegroundChecked] = {t->ink};
  m[kColorNavMenuItemSelected] = {t->ink};
  m[kColorNavMenuItemBackgroundSelected] = {t->raised};
  m[kColorNavMenuItem] = {body};
  m[kColorNavMenuItemBackgroundHover] = {Over(t->hair, t->canvas)};
  m[kColorDownloadToolbarButtonActive] = {t->ink};
  m[kColorDownloadToolbarButtonRingBackground] = {strong_on_card};
  m[kColorDownloadBubblePrimaryIcon] = {body};
  m[kColorPageInfoPermissionUsedIcon] = {body};
  m[ui::kColorBadgeBackground] = {t->raised};
  m[ui::kColorBadgeForeground] = {t->ink};
  m[kColorToolbarActionItemEngaged] = {t->ink};
  m[ui::kColorSysError] = {danger};
  m[ui::kColorSysOnError] = {t->button_fg};
  m[ui::kColorSysErrorContainer] = {Mix(danger, t->raised, t->dark ? 0.22f : 0.10f)};
  m[ui::kColorSysStateDisabled] = {Over(t->mute, t->card)};
  m[ui::kColorSysStateDisabledContainer] = {hair_on_card};
  m[ui::kColorSysSecondary] = {t->mute};
  m[ui::kColorSysStateOnHeaderHover] = {t->ink};
  m[ui::kColorSysInverseSurface] = {t->raised};
  m[ui::kColorSysInverseOnSurface] = {t->ink};
  m[ui::kColorSysInversePrimary] = {t->ink};
  m[ui::kColorToastBackground] = {t->raised};
  m[ui::kColorToastBackgroundProminent] = {t->raised};
  m[ui::kColorToastForeground] = {t->ink};
  m[ui::kColorToastButton] = {t->ink};
  m[kColorFeaturePromoBubbleBackground] = {t->card};
  m[kColorFeaturePromoBubbleForeground] = {t->ink};
  m[kColorFeaturePromoBubbleDefaultButtonBackground] = {t->button_bg};
  m[kColorFeaturePromoBubbleDefaultButtonForeground] = {t->button_fg};
  m[kColorFeaturePromoBubbleButtonBorder] = {strong_on_card};
  m[kColorFeaturePromoBubbleCloseButtonInkDrop] = {t->hair};
  m[kColorTabFocusRingActive] = {accent};
  m[kColorTabFocusRingInactive] = {accent};
  m[kColorTabCloseButtonFocusRingActive] = {accent};
  m[kColorTabCloseButtonFocusRingInactive] = {accent};
  m[kColorTabHoverCardForeground] = {Over(t->hair_strong, t->card)};
  m[kColorTabHoverCardSecondaryText] = {t->mute};
  m[kColorTabDiscardRingFrameActive] = {t->mute};
  m[kColorTabDiscardRingFrameInactive] = {t->mute};
  m[kColorNewTabButtonForegroundFrameActive] = {t->mute};
  m[kColorNewTabButtonForegroundFrameInactive] = {t->mute};
  m[kColorNewTabButtonCRForegroundFrameActive] = {t->mute};
  m[kColorNewTabButtonCRForegroundFrameInactive] = {t->mute};
  m[kColorNewTabButtonInkDropFrameActive] = {t->hair_strong};
  m[kColorNewTabButtonInkDropFrameInactive] = {t->hair_strong};
  m[kColorTabGroupTabStripFrameActiveBlue] = {tint};
  m[kColorTabGroupTabStripFrameInactiveBlue] = {tint};
  m[kColorOmniboxResultsButtonBorder] = {strong_on_card};
  m[kColorOmniboxAnswerIconGM3Background] = {Over(t->hair_strong, t->raised)};
  m[kColorOmniboxAnswerIconGM3Foreground] = {t->ink};
  // The panel's edge reads like the toolbar's rule over the page beside it.
  m[kColorSidePanelContentAreaSeparator] = {hair_on_card};
  // Split view: the focused pane gets a stronger hairline, the other a plain
  // one, both Perch's warm hairlines rather than Google grey.
  m[kColorMultiContentsViewActiveContentOutline] = {
      Over(t->hair_strong, t->canvas)};
  m[kColorMultiContentsViewInactiveContentOutline] = {hair};
  // While the address bar is in use, the pane it will load into wears the
  // focus ring's accent (DESIGN.md), not Material's grey inactive ring.
  m[kColorMultiContentsViewHighlightContentOutline] = {accent};
  m[kColorMultiContentsViewMiniToolbarForeground] = {t->mute};
  m[kColorSplitViewBackground] = {t->canvas};
  m[kColorTabForegroundActiveFrameInactive] = {body};
  m[kColorTabStrokeFrameInactive] = {hair};
  m[kColorSidePanelBackground] = {t->canvas};
  m[kColorSidePanelContentBackground] = {t->canvas};

  // Toolbar button hover and press: the ink at 8% and 12%, as the Spaces
  // button uses, instead of Chromium's max-contrast grey.
  m[kColorToolbarInkDrop] = {t->ink};
  m[kColorToolbarInkDropHover] = {SkColorSetA(t->ink, 0x14)};
  m[kColorToolbarInkDropRipple] = {SkColorSetA(t->ink, 0x1F)};

  // No rules between the toolbar's buttons: the gaps group them (DESIGN.md).
  m[kColorToolbarExtensionSeparatorEnabled] = {SK_ColorTRANSPARENT};
  m[kColorToolbarExtensionSeparatorDisabled] = {SK_ColorTRANSPARENT};
}

void Refresh(Profile* profile) {
  const PrefService* prefs = profile->GetPrefs();
  Appearance& now = Current();
  now.theme = prefs->GetString(prefs::kAppearanceTheme);
  now.accent = prefs->GetString(prefs::kAppearanceAccent);
  now.match_system = prefs->GetBoolean(prefs::kAppearanceMatchSystem);
  now.dark_theme = prefs->GetString(prefs::kAppearanceDarkTheme);
  // Chromium's own colours (menus, dialogs, web contents' dark mode) follow
  // the theme's darkness.
  if (ThemeService* themes = ThemeServiceFactory::GetForProfile(profile)) {
    const PerchThemeTokens* t = FindPerchTheme(now.theme);
    themes->SetBrowserColorScheme(
        now.match_system ? ThemeService::BrowserColorScheme::kSystem
        : t && !t->dark  ? ThemeService::BrowserColorScheme::kLight
                         : ThemeService::BrowserColorScheme::kDark);
  }
  ui::ColorProviderManager::Get().ResetColorProviderCache();
  ui::NativeTheme::GetInstanceForNativeUi()->NotifyOnNativeThemeUpdated();
}

// Density is one setting for the browser; windows lay out again with it.
void RefreshDensity(Profile* profile) {
  SetCompactDensity(
      profile->GetPrefs()->GetString(prefs::kAppearanceDensity) == "compact");
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    if (BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser)) {
      view->ToolbarSizeChanged(/*is_animating=*/false);
      view->InvalidateLayout();
    }
  }
}

// Follows one profile's appearance prefs until the profile goes away.
class Watcher : public base::SupportsUserData::Data, public ProfileObserver {
 public:
  explicit Watcher(Profile* profile) : profile_(profile) {
    profile->AddObserver(this);
    registrar_.Init(profile->GetPrefs());
    for (const char* pref :
         {prefs::kAppearanceTheme, prefs::kAppearanceAccent,
          prefs::kAppearanceMatchSystem, prefs::kAppearanceDarkTheme}) {
      registrar_.Add(pref, base::BindRepeating(&Refresh, profile));
    }
    registrar_.Add(prefs::kAppearanceDensity,
                   base::BindRepeating(&RefreshDensity, profile));
    SetCompactDensity(
        profile->GetPrefs()->GetString(prefs::kAppearanceDensity) == "compact");
  }
  ~Watcher() override {
    if (profile_) {
      profile_->RemoveObserver(this);
    }
  }

  void OnProfileWillBeDestroyed(Profile* profile) override {
    registrar_.RemoveAll();
    profile_->RemoveObserver(this);
    profile_ = nullptr;
  }

 private:
  raw_ptr<Profile> profile_;
  PrefChangeRegistrar registrar_;
};

}  // namespace

const PerchThemeTokens* FindPerchTheme(std::string_view name) {
  for (const PerchThemeTokens& theme : kPerchThemes) {
    if (theme.name == name) {
      return &theme;
    }
  }
  return nullptr;
}

const PerchAccentTokens* FindPerchAccent(std::string_view name) {
  for (const PerchAccentTokens& accent : kPerchAccents) {
    if (accent.name == name) {
      return &accent;
    }
  }
  return nullptr;
}

void ApplyPerchTheme(Profile* profile) {
  static bool installed = false;
  if (!installed) {
    installed = true;
    ui::ColorProviderManager::Get().AppendColorProviderInitializer(
        base::BindRepeating(&AddPerchMixer));
  }
  if (!profile || profile->IsOffTheRecord() ||
      profile->GetUserData(kWatcherKey)) {
    return;
  }
  profile->SetUserData(kWatcherKey, std::make_unique<Watcher>(profile));
  Refresh(profile);
}

}  // namespace perch
