// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/privacy/allowed_connections.h"

#include "base/command_line.h"
#include "chrome/browser/browser_process.h"
#include "components/prefs/pref_registry_simple.h"
#include "components/prefs/pref_service.h"
#include "components/prefs/scoped_user_pref_update.h"

namespace perch {

namespace {

constexpr char kConnectionsPref[] = "perch.connections";

struct Row {
  Connection connection;
  const char* id;
  const char* label;
  const char* detail;
  // What a person who never touched the switch gets.
  bool on_by_default = true;
};

constexpr Row kRows[] = {
    {Connection::kExtensionUpdates, "extension_updates", "Extension updates",
     "Checks the Chrome Web Store for updates to extensions you installed"},
    {Connection::kSafeBrowsingLists, "safe_browsing_lists",
     "Safe Browsing lists",
     "Downloads Google's lists of dangerous sites. Sites you visit are "
     "checked on this Mac and never sent"},
    {Connection::kComponents, "components", "Security and media components",
     "Certificate revocation lists, certificate data, and Widevine for "
     "Netflix and other streaming services"},
    {Connection::kTranslationPacks, "translation_packs", "Translation packs",
     "Downloads a language pack the first time you translate from that "
     "language. Translation then runs on this Mac"},
    {Connection::kPerchUpdates, "perch_updates", "Perch updates",
     "Checks GitHub for new versions of Perch"},
    {Connection::kPushMessaging, "push_messaging", "Push messaging",
     "Lets sites send notifications while they're closed. These go through "
     "Google's servers, which learn which sites you subscribed to",
     /*on_by_default=*/false},
};

const Row* RowFor(Connection connection) {
  for (const Row& row : kRows) {
    if (row.connection == connection) {
      return &row;
    }
  }
  return nullptr;
}

bool Allowed(const PrefService& local_state, const Row& row) {
  return local_state.GetDict(kConnectionsPref).FindBool(row.id).value_or(row.on_by_default);
}

}  // namespace

void RegisterAllowedConnectionPrefs(PrefRegistrySimple* registry) {
  registry->RegisterDictionaryPref(kConnectionsPref);
}

bool IsConnectionAllowed(Connection connection) {
  const PrefService* local_state =
      g_browser_process ? g_browser_process->local_state() : nullptr;
  const Row* row = RowFor(connection);
  return !local_state || !row || Allowed(*local_state, *row);
}

base::ListValue ListConnections(const PrefService& local_state) {
  base::ListValue rows;
  for (const Row& row : kRows) {
    rows.Append(base::DictValue()
                    .Set("id", row.id)
                    .Set("label", row.label)
                    .Set("detail", row.detail)
                    .Set("enabled", Allowed(local_state, row)));
  }
  return rows;
}

bool SetConnectionAllowed(PrefService& local_state,
                          std::string_view id,
                          bool allowed) {
  for (const Row& row : kRows) {
    if (id == row.id) {
      ScopedDictPrefUpdate(&local_state, kConnectionsPref)->Set(id, allowed);
      return true;
    }
  }
  return false;
}

bool FastTimersForNetaudit() {
  return base::CommandLine::ForCurrentProcess()->HasSwitch(
      "perch-netaudit-fast-timers");
}

}  // namespace perch
