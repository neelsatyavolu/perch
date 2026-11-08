// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SNAPSHOT_CHROME_SNAPSHOT_H_
#define CHROME_BROWSER_PERCH_SNAPSHOT_CHROME_SNAPSHOT_H_

class BrowserWindowInterface;

namespace perch {

// The off-screen render of the browser's own window for design review (spec
// 6.9). With --perch-chrome-snapshot=<dir> (headless), the first window
// renders itself through its compositor layer, never the screen, once per
// state in --perch-snapshot-states (default "default"; also "tabs",
// "theme-<name>", "accent-<name>", "hidden-chrome" and "split"), writes
// <dir>/<state>.png, and Perch quits. Called for each new window.
void MaybeStartChromeSnapshot(BrowserWindowInterface* browser);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SNAPSHOT_CHROME_SNAPSHOT_H_
