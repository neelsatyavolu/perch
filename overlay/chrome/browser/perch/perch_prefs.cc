// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_prefs.h"

#include <utility>

#include "base/logging.h"
#include "base/values.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/privacy/allowed_connections.h"
#include "chrome/common/pref_names.h"
#include "components/content_settings/core/browser/cookie_settings.h"
#include "components/content_settings/core/common/pref_names.h"
#include "components/performance_manager/public/user_tuning/prefs.h"
#include "components/pref_registry/pref_registry_syncable.h"
#include "components/prefs/pref_registry.h"
#include "components/prefs/pref_registry_simple.h"
#include "components/prefs/pref_store.h"
#include "components/safe_browsing/core/common/safe_browsing_prefs.h"
#include "components/signin/public/base/signin_pref_names.h"
#include "components/unified_consent/pref_names.h"

namespace perch {

namespace {

// Encrypted DNS's default resolver (spec 5.9). Automatic mode uses it when it
// answers and falls back to the system resolver when it doesn't.
constexpr char kDefaultDohTemplate[] =
    "https://chrome.cloudflare-dns.com/dns-query";

// Changes a default only for a pref that is registered by now; one that moved
// in a Chromium update is logged rather than crashing startup.
void SetDefault(PrefRegistry* registry, const char* name, base::Value value) {
  if (!registry->defaults()->GetValue(name, nullptr)) {
    LOG(ERROR) << "Perch: no pref " << name << " to change the default of";
    return;
  }
  registry->SetDefaultPrefValue(name, std::move(value));
}

}  // namespace

void RegisterLocalStatePrefs(PrefRegistrySimple* registry) {
  RegisterAllowedConnectionPrefs(registry);
  SetDefault(registry, ::prefs::kDnsOverHttpsMode, base::Value("automatic"));
  // Memory saver is on, and a background tab sleeps after 15 minutes.
  namespace tuning = performance_manager::user_tuning::prefs;
  SetDefault(registry, tuning::kMemorySaverModeState,
             base::Value(static_cast<int>(
                 tuning::MemorySaverModeState::kEnabled)));
  SetDefault(registry, tuning::kMemorySaverModeTimeBeforeDiscardInMinutes,
             base::Value(15));
  SetDefault(registry, ::prefs::kDnsOverHttpsTemplates,
             base::Value(kDefaultDohTemplate));
}

void RegisterProfilePrefs(user_prefs::PrefRegistrySyncable* registry) {
  registry->RegisterBooleanPref(prefs::kExtensionPerchEnabled, true);
  registry->RegisterBooleanPref(prefs::kExtensionBackrowEnabled, true);
  registry->RegisterBooleanPref(prefs::kExtensionLulltabEnabled, true);
  registry->RegisterBooleanPref(prefs::kExtensionCaveatlyEnabled, true);

  registry->RegisterStringPref(prefs::kAppearanceTheme, "ink");
  registry->RegisterStringPref(prefs::kAppearanceAccent, "blue");
  registry->RegisterBooleanPref(prefs::kAppearanceMatchSystem, false);
  registry->RegisterStringPref(prefs::kAppearanceDarkTheme, "ink");
  registry->RegisterBooleanPref(prefs::kAppearanceHideChrome, false);
  registry->RegisterListPref(prefs::kMemorySaverRules);
  registry->RegisterBooleanPref(prefs::kAppearanceRevealOnHover, true);
  registry->RegisterStringPref(prefs::kAppearanceDensity, "comfortable");

  registry->RegisterBooleanPref(prefs::kFingerprinting, true);
}

void OverrideChromiumDefaults(user_prefs::PrefRegistrySyncable* registry) {
  SetDefault(registry, ::prefs::kHttpsOnlyModeEnabled, base::Value(true));
  SetDefault(registry, ::prefs::kCookieControlsMode,
             base::Value(static_cast<int>(
                 content_settings::CookieControlsMode::kBlockThirdParty)));
  // Google sign-in and the data Google collects to "make searches and
  // browsing better" stay off; Perch has its own account and sync.
  SetDefault(registry, ::prefs::kSigninAllowed, base::Value(false));
  SetDefault(registry,
             unified_consent::prefs::kUrlKeyedAnonymizedDataCollectionEnabled,
             base::Value(false));
  SetDefault(registry, ::prefs::kSafeBrowsingEnhanced, base::Value(false));
}

}  // namespace perch
