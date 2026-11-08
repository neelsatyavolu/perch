// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef COMPONENTS_TRANSLATE_CORE_BROWSER_PERCH_TRANSLATE_SCRIPT_H_
#define COMPONENTS_TRANSLATE_CORE_BROWSER_PERCH_TRANSLATE_SCRIPT_H_

#include <string>

#include "base/feature_list.h"

namespace translate {

// On by default: pages translate on the Mac, and Google's translate servers
// are never asked for a script or a language list.
BASE_DECLARE_FEATURE(kPerchOnDeviceTranslate);

// Perch's translate script, in place of Google's element.js. It gives the
// translate agent the cr.googleTranslate surface it drives, and translates
// the page's text on the Mac with the Translator API (TranslateKit): no page
// text leaves the computer.
std::string PerchTranslateScript();

}  // namespace translate

#endif  // COMPONENTS_TRANSLATE_CORE_BROWSER_PERCH_TRANSLATE_SCRIPT_H_
