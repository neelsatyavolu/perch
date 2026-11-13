// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_AUTOCOMPLETE_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_AUTOCOMPLETE_H_

#include <memory>
#include <optional>
#include <string>

#include "base/functional/callback.h"
#include "base/memory/raw_ptr.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "components/omnibox/browser/autocomplete_controller.h"
#include "url/gurl.h"

class Profile;

namespace perch {

// The address bar's own suggestions for the new tab page's Search box: the
// same providers (history, bookmarks, shortcuts, search suggestions) and the
// same inline completion. One query runs at a time; a new one replaces it.
class PerchAutocomplete : public AutocompleteController::Observer {
 public:
  explicit PerchAutocomplete(Profile* profile);
  PerchAutocomplete(const PerchAutocomplete&) = delete;
  PerchAutocomplete& operator=(const PerchAutocomplete&) = delete;
  ~PerchAutocomplete() override;

  // Replies with {matches: [{contents, description, url, kind, inline,
  // default}]} once the providers are done, or after a short wait with what
  // they have so far. A query that a newer one replaces replies with no
  // matches.
  void Query(const std::string& text,
             base::OnceCallback<void(base::DictValue)> reply);

  // Where Enter on `text` goes, as in the address bar: the site it names, or
  // (`search` true) a search for it. Nullopt when it is neither.
  struct Target {
    GURL url;
    bool search = false;
  };
  std::optional<Target> Destination(const std::string& text);

  // AutocompleteController::Observer:
  void OnResultChanged(AutocompleteController* controller,
                       bool default_match_changed) override;

 private:
  void Reply();

  raw_ptr<Profile> profile_;
  std::unique_ptr<AutocompleteController> controller_;
  base::OnceCallback<void(base::DictValue)> pending_;
  base::OneShotTimer deadline_;
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_AUTOCOMPLETE_H_
