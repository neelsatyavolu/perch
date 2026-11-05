// Copyright 2026 Neel Satyavolu. MIT licence, see LICENSE in the Perch repo.

#ifndef CHROME_BROWSER_PERCH_PERCH_UPDATER_MAC_H_
#define CHROME_BROWSER_PERCH_PERCH_UPDATER_MAC_H_

namespace perch {

// Starts Sparkle when Sparkle.framework is bundled in Perch.app and adds
// "Check for Updates…" to the app menu. Does nothing when Sparkle is absent,
// as in dev builds. Safe to call more than once.
void StartUpdater();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_PERCH_UPDATER_MAC_H_
