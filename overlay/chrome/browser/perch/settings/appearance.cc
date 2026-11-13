// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/settings/appearance.h"

#include <algorithm>
#include <array>
#include <string_view>

#include "chrome/browser/perch/perch_pref_names.h"
#include "components/prefs/pref_service.h"

namespace perch {

namespace {

constexpr std::array<std::string_view, 7> kThemes = {
    "ink", "graphite", "dusk", "paper", "contrast", "sakura", "yozakura"};
// The light themes, which Match system's dark theme can't be.
constexpr std::array<std::string_view, 2> kLightThemes = {"paper", "sakura"};
constexpr std::array<std::string_view, 6> kAccents = {"blue", "teal",  "amber",
                                                      "rose", "mono",  "sakura"};
constexpr std::array<std::string_view, 2> kDensities = {"comfortable",
                                                        "compact"};

template <size_t N>
bool OneOf(const std::array<std::string_view, N>& names, std::string_view v) {
  return std::find(names.begin(), names.end(), v) != names.end();
}

struct StringField {
  const char* key;
  const char* pref;
  bool (*valid)(std::string_view);
};

struct BoolField {
  const char* key;
  const char* pref;
};

constexpr StringField kStrings[] = {
    {"theme", prefs::kAppearanceTheme,
     [](std::string_view v) { return OneOf(kThemes, v); }},
    {"accent", prefs::kAppearanceAccent,
     [](std::string_view v) { return OneOf(kAccents, v); }},
    {"darkTheme", prefs::kAppearanceDarkTheme,
     [](std::string_view v) {
       return OneOf(kThemes, v) && !OneOf(kLightThemes, v);
     }},
    {"density", prefs::kAppearanceDensity,
     [](std::string_view v) { return OneOf(kDensities, v); }},
};

constexpr BoolField kBools[] = {
    {"matchSystem", prefs::kAppearanceMatchSystem},
    {"hideChrome", prefs::kAppearanceHideChrome},
    {"revealOnHover", prefs::kAppearanceRevealOnHover},
};

}  // namespace

base::DictValue GetAppearance(const PrefService& prefs) {
  base::DictValue result;
  for (const StringField& field : kStrings) {
    result.Set(field.key, prefs.GetString(field.pref));
  }
  for (const BoolField& field : kBools) {
    result.Set(field.key, prefs.GetBoolean(field.pref));
  }
  return result;
}

std::optional<std::string> SetAppearance(PrefService& prefs,
                                         const base::DictValue& patch) {
  // Check everything first, so a bad field leaves the rest untouched.
  for (const auto [key, value] : patch) {
    bool known = false;
    for (const StringField& field : kStrings) {
      if (key == field.key) {
        known = true;
        if (!value.is_string() || !field.valid(value.GetString())) {
          return "Unknown " + key;
        }
      }
    }
    for (const BoolField& field : kBools) {
      if (key == field.key) {
        known = true;
        if (!value.is_bool()) {
          return key + " must be true or false";
        }
      }
    }
    if (!known) {
      return "Unknown appearance setting " + key;
    }
  }
  for (const StringField& field : kStrings) {
    if (const std::string* value = patch.FindString(field.key)) {
      prefs.SetString(field.pref, *value);
    }
  }
  for (const BoolField& field : kBools) {
    if (std::optional<bool> value = patch.FindBool(field.key)) {
      prefs.SetBoolean(field.pref, *value);
    }
  }
  return std::nullopt;
}

}  // namespace perch
