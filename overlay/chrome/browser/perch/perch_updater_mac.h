// Copyright 2026 Neel Satyavolu. MIT licence, see LICENSE in the Perch repo.

#ifndef CHROME_BROWSER_PERCH_PERCH_UPDATER_MAC_H_
#define CHROME_BROWSER_PERCH_PERCH_UPDATER_MAC_H_

#include <optional>
#include <string>

#include "base/time/time.h"

namespace perch {

// Starts Sparkle when Sparkle.framework is bundled in Perch.app and adds
// "Check for Updates…" to the app menu. Does nothing when Sparkle is absent,
// as in dev builds. Safe to call more than once.
void StartUpdater();

// For Settings › About (ui-pages AboutInfo and UpdateStatus).
struct UpdaterInfo {
  // Sparkle is in this build.
  bool available = false;
  bool auto_update = false;
  // The company decides; the switch is locked.
  bool managed = false;
  std::optional<base::Time> last_checked;
  // A downloaded update waiting for Perch to restart, by version.
  std::optional<std::string> ready_version;
};
UpdaterInfo GetUpdaterInfo();
// Turns scheduled checks on or off. False when Sparkle isn't there or a
// policy decides.
bool SetAutoUpdate(bool on);
// Checks now, in Sparkle's window, which also installs. False without Sparkle.
bool CheckForUpdatesNow();
// Installs the downloaded update now and relaunches Perch. False when no update
// is ready.
bool InstallReadyUpdate();
// Turns the app menu's "Check for Updates…" into "Restart to Update Perch"
// once an update is ready (called by the updater; safe to call any time).
void ShowRestartToUpdateItem();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_UPDATER_MAC_H_
