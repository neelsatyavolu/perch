// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_PRIVACY_ALLOWED_CONNECTIONS_H_
#define CHROME_BROWSER_PERCH_PRIVACY_ALLOWED_CONNECTIONS_H_

#include <string_view>

#include "base/values.h"

class PrefRegistrySimple;
class PrefService;

namespace perch {

// The connections Perch makes on its own (spec 5.1), each with a switch in
// Settings → Privacy. All are on by default. build/allowed-hosts.json lists
// the hosts each one may reach, and perch-build netaudit checks it.
enum class Connection {
  kExtensionUpdates,
  kSafeBrowsingLists,
  kComponents,
  kTranslationPacks,
  kPerchUpdates,
  kPushMessaging,
  kBuiltInExtensionUpdates,
};

void RegisterAllowedConnectionPrefs(PrefRegistrySimple* registry);

// Whether `connection` may run, from local state. Safe to call before local
// state exists (it then answers yes).
bool IsConnectionAllowed(Connection connection);

// The rows for Settings: [{id, label, detail, enabled}].
base::ListValue ListConnections(const PrefService& local_state);

// Switches one connection by id. Returns false for an unknown id. Scheduled
// checks follow the switch from their next run; a check already started
// finishes.
bool SetConnectionAllowed(PrefService& local_state,
                          std::string_view id,
                          bool allowed);

// Whether netaudit asked for update checks to start within seconds.
bool FastTimersForNetaudit();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PRIVACY_ALLOWED_CONNECTIONS_H_
