// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_THEME_PERCH_THEME_H_
#define CHROME_BROWSER_PERCH_THEME_PERCH_THEME_H_

#include <cstdint>
#include <string_view>

class Profile;

namespace perch {

struct PerchThemeTokens {
  std::string_view name;
  bool dark;
  uint32_t canvas, card, raised, ink, body, mute, hair, hair_strong, button_bg,
      button_fg;
};

struct PerchAccentTokens {
  std::string_view name;
  uint32_t on_dark, on_paper;
};

// The theme and accent tables from DESIGN.md (theme/perch_tokens.inc).
const PerchThemeTokens* FindPerchTheme(std::string_view name);
const PerchAccentTokens* FindPerchAccent(std::string_view name);

// Paints the browser window in Perch's theme (DESIGN.md "Surfaces in the
// browser"): a colour mixer added after Chromium's own, so a theme from the
// Chrome Web Store still wins and "Reset to default" comes back to Perch's.
// It follows Settings → Appearance for `profile` from now on. Safe to call for
// every new window.
void ApplyPerchTheme(Profile* profile);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_THEME_PERCH_THEME_H_
