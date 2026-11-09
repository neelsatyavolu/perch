// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_IMPORT_BUNDLE_H_
#define CHROME_BROWSER_PERCH_AGENT_IMPORT_BUNDLE_H_

#include "base/functional/callback_forward.h"
#include "chrome/browser/perch/agent/perch_domain_data.h"

class Profile;

namespace perch {

// Perch.applyImportBundle {path} (plan 3b task 14): reads the plain bundle
// perchd wrote under "<user data>/Perch Import/applying/", and adds its
// bookmarks, history, passwords, tabs (asleep) and search engines to
// `profile` through Chromium's importer. Replies
// {applied: {bookmarks, history, passwords, cookies, tabs, searchEngines, extensions,
// addresses},
// skipped: [types left in the sealed bundle]}. perchd deletes the file.
void ApplyImportBundle(Profile* profile,
                       const base::DictValue& params,
                       base::OnceCallback<void(DataResult)> reply);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_IMPORT_BUNDLE_H_
