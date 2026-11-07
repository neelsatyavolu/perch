// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SETTINGS_PRIVACY_H_
#define CHROME_BROWSER_PERCH_SETTINGS_PRIVACY_H_

#include <string>

#include "base/functional/callback.h"
#include "base/types/expected.h"
#include "base/values.h"

class Profile;

namespace perch {

// A PrivacySettings object (ui-pages/src/api.ts), or a message for the page.
using PrivacyResult = base::expected<base::DictValue, std::string>;
using PrivacyCallback = base::OnceCallback<void(PrivacyResult)>;

// Reads Chromium's privacy prefs and the Perch extension's own switches (its
// chrome.storage.local "settings" object; extension/src/shared/settings.ts).
void GetPrivacy(Profile* profile, PrivacyCallback callback);

// Applies a PrivacyPatch. The blocker switches are written to the extension's
// storage, which its service worker watches. Nothing changes when the patch
// has an unknown field or a bad value.
void SetPrivacy(Profile* profile,
                const base::DictValue& patch,
                PrivacyCallback callback);

// Turns the content blocker back on for `host` (and its subdomains).
void RemoveBlockerException(Profile* profile,
                            const std::string& host,
                            PrivacyCallback callback);

// Clears the site's cookies, storage and cache, for its whole registrable
// domain ("Forget this site", spec 5.9).
bool ForgetSite(Profile* profile, const std::string& host);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SETTINGS_PRIVACY_H_
