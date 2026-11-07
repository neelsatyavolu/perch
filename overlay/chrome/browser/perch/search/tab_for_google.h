// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SEARCH_TAB_FOR_GOOGLE_H_
#define CHROME_BROWSER_PERCH_SEARCH_TAB_FOR_GOOGLE_H_

class AutocompleteSchemeClassifier;
class OmniboxEditModel;
class TemplateURLService;

namespace perch {

// Tab for Google (spec 5.4): with Brave as the default engine, Tab on a typed
// search switches it to Google, and Tab again switches back. Returns true when
// it handled the key; otherwise Chromium's own Tab behaviour runs. Called from
// OmniboxEditModel::OnTabPressed().
bool HandleTabForGoogle(OmniboxEditModel* model,
                        TemplateURLService* template_urls,
                        const AutocompleteSchemeClassifier& classifier,
                        bool shift);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SEARCH_TAB_FOR_GOOGLE_H_
