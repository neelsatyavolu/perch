// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_prefs.h"

#include "chrome/browser/perch/perch_pref_names.h"
#include "components/pref_registry/pref_registry_syncable.h"
#include "components/prefs/pref_registry_simple.h"

namespace perch {

void RegisterLocalStatePrefs(PrefRegistrySimple* registry) {}

void RegisterProfilePrefs(user_prefs::PrefRegistrySyncable* registry) {
  registry->RegisterBooleanPref(prefs::kExtensionPerchEnabled, true);
  registry->RegisterBooleanPref(prefs::kExtensionBackrowEnabled, true);
  registry->RegisterBooleanPref(prefs::kExtensionLulltabEnabled, true);
  registry->RegisterBooleanPref(prefs::kExtensionCaveatlyEnabled, true);
}

void OverrideChromiumDefaults(user_prefs::PrefRegistrySyncable* registry) {}

}  // namespace perch
