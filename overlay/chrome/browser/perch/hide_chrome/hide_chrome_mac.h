// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_HIDE_CHROME_HIDE_CHROME_MAC_H_
#define CHROME_BROWSER_PERCH_HIDE_CHROME_HIDE_CHROME_MAC_H_

#include <memory>

class BrowserWindowInterface;

namespace perch {

// The macOS half of hide-chrome mode (spec 5.3).

// Hides the window's traffic lights while the bars are hidden and shows them
// with the bars.
void SetTrafficLightsHidden(BrowserWindowInterface* browser, bool hidden);

// Watches one window's mouse and keys while hide-chrome is on:
// - with perch.appearance.reveal_on_hover, resting the pointer on the top
//   4 px for 150 ms shows the bars, and moving below them hides them again
//   unless the address bar has focus;
// - ⌃Tab opens the command bar, which searches open tabs, since the tab strip
//   isn't there to look at.
class HideChromeMonitor {
 public:
  virtual ~HideChromeMonitor() = default;
};
std::unique_ptr<HideChromeMonitor> CreateHideChromeMonitor(
    BrowserWindowInterface* browser);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_HIDE_CHROME_HIDE_CHROME_MAC_H_
