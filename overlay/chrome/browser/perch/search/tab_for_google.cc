// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/search/tab_for_google.h"

#include <string>

#include "base/strings/string_util.h"
#include "chrome/browser/ui/omnibox/omnibox_edit_model.h"
#include "components/omnibox/browser/autocomplete_input.h"
#include "components/omnibox/browser/autocomplete_scheme_classifier.h"
#include "components/search_engines/search_engine_type.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_service.h"
#include "third_party/metrics_proto/omnibox_event.pb.h"
#include "third_party/metrics_proto/omnibox_input_type.pb.h"

namespace perch {

namespace {

const TemplateURL* GoogleEngine(TemplateURLService* template_urls) {
  for (const TemplateURL* url : template_urls->GetTemplateURLs()) {
    if (url->GetEngineType(template_urls->search_terms_data()) ==
            SEARCH_ENGINE_GOOGLE &&
        url->prepopulate_id() > 0) {
      return url;
    }
  }
  return nullptr;
}

bool IsQuery(const std::u16string& text,
             const AutocompleteSchemeClassifier& classifier) {
  const std::u16string trimmed(
      base::TrimWhitespace(text, base::TRIM_ALL));
  if (trimmed.empty()) {
    return false;
  }
  // Something that looks like an address keeps Chromium's Tab behaviour.
  AutocompleteInput input(trimmed, metrics::OmniboxEventProto::OTHER,
                          classifier);
  return input.type() == metrics::OmniboxInputType::QUERY;
}

}  // namespace

bool HandleTabForGoogle(OmniboxEditModel* model,
                        TemplateURLService* template_urls,
                        const AutocompleteSchemeClassifier& classifier,
                        bool shift) {
  if (shift || !template_urls || !template_urls->loaded()) {
    return false;
  }
  const TemplateURL* google = GoogleEngine(template_urls);
  const TemplateURL* fallback = template_urls->GetDefaultSearchProvider();
  if (!google || !fallback ||
      fallback->GetEngineType(template_urls->search_terms_data()) !=
          SEARCH_ENGINE_BRAVE) {
    return false;
  }
  if (model->is_keyword_selected()) {
    if (model->keyword() != google->keyword()) {
      return false;
    }
    model->ClearKeyword();
    return true;
  }
  if (!IsQuery(model->user_text(), classifier)) {
    return false;
  }
  model->EnterKeywordMode(metrics::OmniboxEventProto::TAB, google,
                          std::u16string());
  return true;
}

}  // namespace perch
