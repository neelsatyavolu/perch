// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SETTINGS_SITE_DATA_H_
#define CHROME_BROWSER_PERCH_SETTINGS_SITE_DATA_H_

#include "base/functional/callback_forward.h"
#include "base/values.h"

class Profile;

namespace perch {

// Settings › Privacy › Site data: [{host, bytes, cookies}] per site, largest
// first, from Chromium's browsing data model.
void ListSiteData(Profile* profile,
                  base::OnceCallback<void(base::ListValue)> reply);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SETTINGS_SITE_DATA_H_
