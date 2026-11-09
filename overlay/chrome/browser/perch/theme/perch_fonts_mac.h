// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_THEME_PERCH_FONTS_MAC_H_
#define CHROME_BROWSER_PERCH_THEME_PERCH_FONTS_MAC_H_

namespace perch {

// Registers the Geist fonts Perch ships (SIL OFL, in the framework's
// Resources/perch_fonts, or out/<config>/perch_fonts in development builds)
// for this process, and makes Geist 13 px the browser's interface font
// (DESIGN.md). Call once at startup, before any window. Without the fonts,
// Perch keeps the system font.
void RegisterPerchFonts();

// Whether Geist Mono registered, for monospaced text in the browser's views.
bool HasPerchMonoFont();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_THEME_PERCH_FONTS_MAC_H_
