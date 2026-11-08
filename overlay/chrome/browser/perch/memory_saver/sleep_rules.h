// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEP_RULES_H_
#define CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEP_RULES_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/types/expected.h"
#include "base/values.h"

class GURL;

namespace perch {

// A "never sleep" rule, ported from Lulltab's lib/whitelist.js so rules mean
// the same thing in both.
struct SleepRule {
  enum class Kind {
    kDomain,    // example.com: the domain and every subdomain.
    kHost,      // =mail.google.com: only that host.
    kWildcard,  // *.example.com: subdomains, not the domain itself.
    kPrefix,    // github.com/neel or https://github.com/neel: a URL prefix.
    kUrl,       // One exact URL.
  };

  Kind kind;
  std::string pattern;

  bool operator==(const SleepRule&) const = default;
};

// Reads what a person typed. The error is a sentence to show them.
base::expected<SleepRule, std::string> ParseSleepPattern(std::string_view input);

// Whether an http(s) URL falls under `rule`.
bool Matches(const GURL& url, const SleepRule& rule);
bool MatchesAny(const GURL& url, const std::vector<SleepRule>& rules);

// Rules as stored in the perch.memory_saver.rules list pref:
// [{"kind": "domain", "pattern": "example.com"}, ...]. Entries that don't
// read as a rule are skipped.
std::vector<SleepRule> RulesFromList(const base::ListValue& list);
base::ListValue RulesToList(const std::vector<SleepRule>& rules);

std::string_view KindName(SleepRule::Kind kind);
std::optional<SleepRule::Kind> KindFromName(std::string_view name);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_MEMORY_SAVER_SLEEP_RULES_H_
