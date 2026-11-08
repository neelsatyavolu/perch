// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/memory_saver/sleep_rules.h"

#include <algorithm>

#include "base/strings/strcat.h"
#include "base/strings/string_util.h"
#include "url/gurl.h"
#include "url/url_constants.h"

namespace perch {

namespace {

constexpr std::pair<SleepRule::Kind, std::string_view> kKindNames[] = {
    {SleepRule::Kind::kDomain, "domain"},
    {SleepRule::Kind::kHost, "host"},
    {SleepRule::Kind::kWildcard, "wildcard"},
    {SleepRule::Kind::kPrefix, "prefix"},
    {SleepRule::Kind::kUrl, "url"},
};

std::string StripTrailingSlash(std::string_view value) {
  if (value.ends_with('/')) {
    value.remove_suffix(1);
  }
  return std::string(value);
}

// Lower case, without a trailing dot or a leading "www.".
std::string NormalizeHost(std::string_view host) {
  std::string out = base::ToLowerASCII(
      base::TrimWhitespaceASCII(host, base::TRIM_ALL));
  if (out.ends_with('.')) {
    out.pop_back();
  }
  if (out.starts_with("www.")) {
    out.erase(0, 4);
  }
  return out;
}

bool StartsWithHttp(std::string_view value) {
  return base::StartsWith(value, "http://",
                          base::CompareCase::INSENSITIVE_ASCII) ||
         base::StartsWith(value, "https://",
                          base::CompareCase::INSENSITIVE_ASCII);
}

std::string Origin(const GURL& url) {
  std::string origin = base::StrCat({url.scheme(), "://", url.host()});
  if (url.has_port()) {
    base::StrAppend(&origin, {":", url.port()});
  }
  return origin;
}

std::string Search(const GURL& url) {
  return url.query().empty() ? std::string() : base::StrCat({"?", url.query()});
}

bool MatchesPrefix(const GURL& url, const std::string& pattern) {
  if (StartsWithHttp(pattern)) {
    const std::string href = base::StrCat({Origin(url), url.path(), Search(url)});
    const std::string base = StripTrailingSlash(pattern);
    return href == pattern || href == base || href.starts_with(base + "/");
  }
  const std::string haystack =
      base::StrCat({NormalizeHost(url.host()), url.path(), Search(url)});
  std::string_view needle_view = pattern;
  if (needle_view.starts_with("www.")) {
    needle_view.remove_prefix(4);
  }
  const std::string needle = StripTrailingSlash(needle_view);
  return haystack == needle || haystack.starts_with(needle + "/");
}

}  // namespace

base::expected<SleepRule, std::string> ParseSleepPattern(
    std::string_view input) {
  const std::string raw(base::TrimWhitespaceASCII(input, base::TRIM_ALL));
  if (raw.empty()) {
    return base::unexpected("Enter a URL, domain, or pattern.");
  }
  const bool has_space = std::ranges::any_of(
      raw, [](char c) { return base::IsAsciiWhitespace(c); });
  if (has_space && raw.find("://") == std::string::npos) {
    return base::unexpected("Patterns cannot contain spaces.");
  }

  if (raw.starts_with('=')) {
    std::string host = NormalizeHost(std::string_view(raw).substr(1));
    if (host.empty()) {
      return base::unexpected("Enter a hostname after =.");
    }
    return SleepRule{SleepRule::Kind::kHost, std::move(host)};
  }

  if (raw.starts_with("*.")) {
    std::string domain = NormalizeHost(std::string_view(raw).substr(2));
    if (domain.empty()) {
      return base::unexpected("Enter a domain after *.");
    }
    return SleepRule{SleepRule::Kind::kWildcard, std::move(domain)};
  }

  if (StartsWithHttp(raw)) {
    const GURL url(raw);
    if (!url.is_valid() || !url.SchemeIsHTTPOrHTTPS()) {
      return base::unexpected("That URL looks invalid.");
    }
    const std::string path =
        url.path() == "/" ? std::string() : StripTrailingSlash(url.path());
    if (path.empty() && Search(url).empty()) {
      return SleepRule{SleepRule::Kind::kHost, NormalizeHost(url.host())};
    }
    return SleepRule{
        SleepRule::Kind::kPrefix,
        StripTrailingSlash(base::StrCat({Origin(url), url.path(), Search(url)}))};
  }

  if (const size_t slash = raw.find('/'); slash != std::string::npos) {
    const std::string host = NormalizeHost(std::string_view(raw).substr(0, slash));
    std::string path = StripTrailingSlash(std::string_view(raw).substr(slash));
    if (path.empty()) {
      path = "/";
    }
    if (host.empty()) {
      return base::unexpected("Enter a hostname before the path.");
    }
    return SleepRule{SleepRule::Kind::kPrefix, host + path};
  }

  std::string host = NormalizeHost(raw);
  if (host.empty() || host.find('.') == std::string::npos) {
    return base::unexpected(
        "Use a domain like example.com, *.example.com, or a full URL.");
  }
  return SleepRule{SleepRule::Kind::kDomain, std::move(host)};
}

bool Matches(const GURL& url, const SleepRule& rule) {
  if (rule.pattern.empty() || !url.is_valid() || !url.SchemeIsHTTPOrHTTPS()) {
    return false;
  }
  const std::string host = NormalizeHost(url.host());
  const std::string& pattern = rule.pattern;
  switch (rule.kind) {
    case SleepRule::Kind::kDomain:
      return host == pattern || host.ends_with("." + pattern);
    case SleepRule::Kind::kHost:
      return host == pattern;
    case SleepRule::Kind::kWildcard:
      return host.ends_with("." + pattern);
    case SleepRule::Kind::kUrl:
      return StripTrailingSlash(url.spec()) == StripTrailingSlash(pattern);
    case SleepRule::Kind::kPrefix:
      return MatchesPrefix(url, pattern);
  }
  return false;
}

bool MatchesAny(const GURL& url, const std::vector<SleepRule>& rules) {
  return std::ranges::any_of(
      rules, [&](const SleepRule& rule) { return Matches(url, rule); });
}

std::string_view KindName(SleepRule::Kind kind) {
  for (const auto& [k, name] : kKindNames) {
    if (k == kind) {
      return name;
    }
  }
  return {};
}

std::optional<SleepRule::Kind> KindFromName(std::string_view name) {
  for (const auto& [kind, k_name] : kKindNames) {
    if (k_name == name) {
      return kind;
    }
  }
  return std::nullopt;
}

std::vector<SleepRule> RulesFromList(const base::ListValue& list) {
  std::vector<SleepRule> rules;
  for (const base::Value& item : list) {
    const base::DictValue* dict = item.GetIfDict();
    if (!dict) {
      continue;
    }
    const std::string* kind = dict->FindString("kind");
    const std::string* pattern = dict->FindString("pattern");
    std::optional<SleepRule::Kind> parsed =
        kind ? KindFromName(*kind) : std::nullopt;
    if (parsed && pattern && !pattern->empty()) {
      rules.push_back({*parsed, *pattern});
    }
  }
  return rules;
}

base::ListValue RulesToList(const std::vector<SleepRule>& rules) {
  base::ListValue list;
  for (const SleepRule& rule : rules) {
    list.Append(base::DictValue()
                    .Set("kind", KindName(rule.kind))
                    .Set("pattern", rule.pattern));
  }
  return list;
}

}  // namespace perch
