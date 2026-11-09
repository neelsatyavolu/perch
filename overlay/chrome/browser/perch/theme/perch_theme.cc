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
  if (key.contrast_mode == ui::ColorProviderKey::ContrastMode::kHigh) {
    name = "contrast";
  }
  const PerchThemeTokens* t = FindPerchTheme(name);
  const PerchAccentTokens* a = FindPerchAccent(now.accent);
  if (!t || !a) {
    return;
  }
  const SkColor accent = t->dark ? a->on_dark : a->on_paper;
  const SkColor hair = Over(t->hair, t->canvas);
  const SkColor body = Over(t->body, t->card);
  const SkColor tint = Mix(accent, t->raised, t->dark ? 0.22f : 0.10f);

  ui::ColorMixer& m = provider->AddMixer();
  // Canvas: the tab strip and the frame around it.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{ui::kColorFrameActive, ui::kColorFrameInactive,
                         kColorTabBackgroundInactiveFrameActive,
                         kColorTabBackgroundInactiveFrameInactive,
                         kColorNewTabButtonBackgroundFrameActive}) {
    m[id] = {t->canvas};
  }
  // Card: the toolbar and the active tab, which join into one piece.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorToolbar, kColorTabBackgroundActiveFrameActive,
        kColorTabBackgroundActiveFrameInactive, kColorBookmarkBarBackground,
        kColorSidePanelBackground, kColorSidePanelContentBackground,
        kColorTabHoverCardBackground}) {
    m[id] = {t->card};
  }
  // Elevated: the address bar.
  m[kColorLocationBarBackground] = {t->raised};
  m[kColorLocationBarBackgroundHovered] = {Over(t->hair_strong, t->raised)};
  m[kColorLocationBarBorder] = {Over(t->hair_strong, t->card)};
  m[kColorLocationBarBorderOpaque] = {Over(t->hair_strong, t->card)};
  // Text and icons.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorTabForegroundActiveFrameActive,
        kColorTabForegroundActiveFrameInactive, kColorOmniboxText,
        kColorBookmarkBarForeground}) {
    m[id] = {t->ink};
  }
  m[kColorToolbarButtonIcon] = {body};
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorTabForegroundInactiveFrameActive,
                         kColorTabForegroundInactiveFrameInactive,
                         kColorOmniboxTextDimmed,
                         kColorToolbarButtonIconInactive}) {
    m[id] = {t->mute};
  }
  // Hairlines.
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{kColorToolbarSeparator, kColorTabDividerFrameActive,
        kColorTabDividerFrameInactive, kColorToolbarContentAreaSeparator,
        kColorToolbarTopSeparatorFrameActive, kColorTabStrokeFrameActive}) {
    m[id] = {hair};
  }
  // The accent: focus rings, text selection and the app menu's highlight.
  m[ui::kColorFocusableBorderFocused] = {accent};
  m[ui::kColorTextSelectionBackground] = {tint};
  m[kColorAppMenuHighlightDefault] = {accent};
  m[kColorOmniboxKeywordSelected] = {accent};

  // Tabs that are hovered or picked for a multi-tab action step up from the
  // canvas; Chromium's own selection blue doesn't belong in a Perch theme.
  const SkColor tab_hover = Over(t->hair_strong, t->canvas);
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
    m[id] = {t->raised};
  }
  for (ui::ColorId id : std::initializer_list<ui::ColorId>{
           kColorTabForegroundInactiveHoverFrameActive,
           kColorTabForegroundInactiveHoverFrameInactive}) {
    m[id] = {body};
  }

  // The address bar's suggestions: an elevated surface, rows that step up on
  // hover and selection, ink and mute text, and URLs in the accent.
  const SkColor row_hover = Over(t->hair, t->raised);
  const SkColor row_selected = Over(t->hair_strong, t->raised);
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
  m[kColorOmniboxResultsUrl] = {accent};
  m[kColorOmniboxResultsUrlSelected] = {accent};
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
           ui::kColorSysPrimaryContainer, ui::kColorSysTonalContainer,
           ui::kColorSysBaseTonalContainer, ui::kColorSysStateTextHighlight}) {
    m[id] = {tint};
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
  m[ui::kColorMenuBackground] = {t->raised};
  m[ui::kColorMenuItemBackgroundHighlighted] = {Over(t->hair_strong, t->raised)};
  m[ui::kColorMenuSeparator] = {Over(t->hair, t->raised)};

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
