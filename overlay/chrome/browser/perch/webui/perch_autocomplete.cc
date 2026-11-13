// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_autocomplete.h"

#include <utility>

#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "chrome/browser/autocomplete/autocomplete_classifier_factory.h"
#include "chrome/browser/autocomplete/chrome_autocomplete_provider_client.h"
#include "chrome/browser/autocomplete/chrome_autocomplete_scheme_classifier.h"
#include "chrome/browser/profiles/profile.h"
#include "components/omnibox/browser/autocomplete_classifier.h"
#include "components/omnibox/browser/autocomplete_controller_config.h"
#include "components/omnibox/browser/autocomplete_input.h"
#include "components/omnibox/browser/autocomplete_match.h"
#include "components/omnibox/browser/autocomplete_provider.h"
#include "components/omnibox/browser/autocomplete_result.h"
#include "third_party/metrics_proto/omnibox_event.pb.h"

namespace perch {

namespace {

constexpr auto kPage = metrics::OmniboxEventProto::NTP_REALBOX;
// Long enough for history and bookmarks, short enough to feel instant; search
// suggestions that arrive later show on the next keystroke.
constexpr base::TimeDelta kWait = base::Milliseconds(250);
constexpr size_t kMaxMatches = 8;

int Providers() {
  // The address bar's set, without the slow, one-query-at-a-time embeddings.
  return AutocompleteClassifier::DefaultOmniboxProviders() &
         ~static_cast<int>(AutocompleteProvider::Type::kHistoryEmbeddings);
}

}  // namespace

PerchAutocomplete::PerchAutocomplete(Profile* profile)
    : profile_(profile),
      controller_(std::make_unique<AutocompleteController>(
          std::make_unique<ChromeAutocompleteProviderClient>(profile),
          AutocompleteControllerConfig{.provider_types = Providers()})) {
  controller_->AddObserver(this);
}

PerchAutocomplete::~PerchAutocomplete() {
  controller_->RemoveObserver(this);
}

void PerchAutocomplete::Query(const std::string& text,
                              base::OnceCallback<void(base::DictValue)> reply) {
  // A newer query wins; the older page call gets an empty answer.
  if (pending_) {
    std::move(pending_).Run(base::DictValue().Set("matches", base::ListValue()));
  }
  deadline_.Stop();
  const std::u16string input_text = base::UTF8ToUTF16(text);
  if (input_text.empty()) {
    controller_->Stop(AutocompleteStopReason::kClobbered);
    std::move(reply).Run(base::DictValue().Set("matches", base::ListValue()));
    return;
  }
  pending_ = std::move(reply);
  AutocompleteInput input(input_text, input_text.size(), kPage,
                          ChromeAutocompleteSchemeClassifier(profile_));
  controller_->Start(input);
  if (controller_->done()) {
    Reply();
    return;
  }
  deadline_.Start(FROM_HERE, kWait,
                  base::BindOnce(&PerchAutocomplete::Reply,
                                 base::Unretained(this)));
}

void PerchAutocomplete::OnResultChanged(AutocompleteController* controller,
                                        bool default_match_changed) {
  if (pending_ && controller->done()) {
    deadline_.Stop();
    Reply();
  }
}

void PerchAutocomplete::Reply() {
  if (!pending_) {
    return;
  }
  base::ListValue matches;
  for (const AutocompleteMatch& match : controller_->result()) {
    if (matches.size() >= kMaxMatches) {
      break;
    }
    if (!match.destination_url.is_valid()) {
      continue;
    }
    matches.Append(
        base::DictValue()
            .Set("contents", match.contents)
            .Set("description", match.description)
            .Set("url", match.destination_url.spec())
            .Set("kind",
                 AutocompleteMatch::IsSearchType(match.type) ? "search" : "url")
            .Set("inline", match.inline_autocompletion)
            .Set("default", match.allowed_to_be_default_match));
  }
  std::move(pending_).Run(base::DictValue().Set("matches", std::move(matches)));
}

std::optional<PerchAutocomplete::Target> PerchAutocomplete::Destination(const std::string& text) {
  AutocompleteClassifier* classifier =
      AutocompleteClassifierFactory::GetForProfile(profile_);
  if (!classifier) {
    return std::nullopt;
  }
  AutocompleteMatch match;
  classifier->Classify(base::UTF8ToUTF16(text), /*in_keyword_mode=*/false,
                       /*allow_exact_keyword_match=*/false, kPage, &match,
                       /*alternate_nav_url=*/nullptr);
  if (!match.destination_url.is_valid()) {
    return std::nullopt;
  }
  return Target{match.destination_url,
                AutocompleteMatch::IsSearchType(match.type)};
}

}  // namespace perch
