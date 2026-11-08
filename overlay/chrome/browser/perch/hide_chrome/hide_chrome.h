// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_HIDE_CHROME_HIDE_CHROME_H_
#define CHROME_BROWSER_PERCH_HIDE_CHROME_HIDE_CHROME_H_

class BrowserWindowInterface;

namespace perch {

// Hide-chrome mode (spec 5.3): the tab strip, toolbar and bookmarks bar go
// away and the page fills the window. It follows Settings → Appearance (the
// perch.appearance.hide_chrome pref), View → Hide Browser Chrome and ⇧⌘\.
// Focusing the address bar (⌘L) brings the bars back until it loses focus.

// Whether `browser`'s bars are hidden right now. BrowserView asks this from
// ShouldDrawTabStrip(), IsToolbarVisible() and IsBookmarkBarVisible().
bool IsChromeHidden(const BrowserWindowInterface* browser);

// Shows the bars while the address bar has focus, or hides them again.
void SetChromeRevealed(BrowserWindowInterface* browser, bool revealed);

// Flips the setting for the window's profile.
void ToggleHideChrome(BrowserWindowInterface* browser);

// Per-window setup and teardown, from InitWindowFeatures().
void WatchHideChrome(BrowserWindowInterface* browser);
void UnwatchHideChrome(BrowserWindowInterface* browser);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_HIDE_CHROME_HIDE_CHROME_H_
