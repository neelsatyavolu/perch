// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_PERCH_DOMAIN_DATA_H_
#define CHROME_BROWSER_PERCH_AGENT_PERCH_DOMAIN_DATA_H_

#include <string>

#include "base/functional/callback_forward.h"
#include "base/types/expected.h"
#include "base/values.h"

class Profile;

namespace perch {

// The browser data perchd reads and writes for sync and import (plan 3b task
// 14), shaped as perchd/src/browser/perch-domain.ts expects. Errors are
// sentences for the reply.
using DataResult = base::expected<base::DictValue, std::string>;

// The profile perchd works for: the last active window's, never incognito.
Profile* AgentProfile();

DataResult GetBookmarks(Profile* profile);
DataResult ApplyBookmarkChanges(Profile* profile, const base::DictValue& params);
void GetHistory(Profile* profile,
                const base::DictValue& params,
                base::OnceCallback<void(DataResult)> reply);
DataResult AddHistory(Profile* profile, const base::DictValue& params);
DataResult GetOpenTabs(Profile* profile);
// The chrome.tabs id of a tab, which extensions use.
DataResult GetExtensionTabId(const base::DictValue& params);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_PERCH_DOMAIN_DATA_H_
