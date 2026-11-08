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
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/browser/themes/theme_service.h"
#include "chrome/browser/themes/theme_service_factory.h"
#include "chrome/browser/ui/color/chrome_color_id.h"
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
