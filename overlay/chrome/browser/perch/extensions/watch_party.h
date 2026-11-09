// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_EXTENSIONS_WATCH_PARTY_H_
#define CHROME_BROWSER_PERCH_EXTENSIONS_WATCH_PARTY_H_

class GURL;
class Profile;

namespace tabs {
class TabInterface;
}

namespace perch {

// Backrow's id (build/bundled-extensions.json).
inline constexpr char kBackrowExtensionId[] = "ajhempjobmeelmhloiiecnbljbpoohcc";

// Whether the tab menu offers "Start Watch Party": Backrow is on and `url` is
// on one of the streaming sites Backrow supports.
bool CanStartWatchParty(Profile* profile, const GURL& url);

// Brings `tab` forward and opens Backrow's popup, where the party starts. If
// the popup can't show (the toolbar is hidden), opens it as a tab instead.
void StartWatchParty(tabs::TabInterface* tab);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_EXTENSIONS_WATCH_PARTY_H_
