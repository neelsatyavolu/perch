// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

// Lulltab's tests/whitelist.test.js, one case for one.

#include "chrome/browser/perch/memory_saver/sleep_rules.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace perch {
namespace {

using Kind = SleepRule::Kind;

SleepRule Parse(std::string_view input) {
  auto rule = ParseSleepPattern(input);
  EXPECT_TRUE(rule.has_value()) << input << ": " << rule.error();
  return rule.value_or(SleepRule{Kind::kDomain, ""});
}

bool Match(std::string_view url, const SleepRule& rule) {
  return Matches(GURL(url), rule);
}

TEST(SleepRulesTest, ParsesEachKind) {
  EXPECT_EQ(Parse("github.com"), (SleepRule{Kind::kDomain, "github.com"}));
  EXPECT_EQ(Parse("www.github.com"), (SleepRule{Kind::kDomain, "github.com"}));
  EXPECT_EQ(Parse("*.notion.so"), (SleepRule{Kind::kWildcard, "notion.so"}));
  EXPECT_EQ(Parse("=mail.google.com"),
            (SleepRule{Kind::kHost, "mail.google.com"}));
  EXPECT_EQ(Parse("https://mail.google.com"),
            (SleepRule{Kind::kHost, "mail.google.com"}));
  EXPECT_EQ(Parse("https://mail.google.com/mail/u/0/"),
            (SleepRule{Kind::kPrefix, "https://mail.google.com/mail/u/0"}));
  EXPECT_EQ(Parse("github.com/neel/still"),
            (SleepRule{Kind::kPrefix, "github.com/neel/still"}));
}

TEST(SleepRulesTest, RejectsEmptyAndInvalid) {
  EXPECT_NE(ParseSleepPattern(" ").error().find("Enter"), std::string::npos);
  EXPECT_NE(ParseSleepPattern("localhost").error().find("domain"),
            std::string::npos);
  EXPECT_NE(ParseSleepPattern("not a url.com extra").error().find("spaces"),
            std::string::npos);
}

TEST(SleepRulesTest, DomainMatchesApexAndSubdomains) {
  const SleepRule rule = Parse("example.com");
  EXPECT_TRUE(Match("https://example.com/a", rule));
  EXPECT_TRUE(Match("https://www.example.com/", rule));
  EXPECT_TRUE(Match("https://app.example.com/x", rule));
  EXPECT_FALSE(Match("https://notexample.com/", rule));
  EXPECT_FALSE(Match("https://example.org/", rule));
}

TEST(SleepRulesTest, WildcardMatchesSubdomainsOnly) {
  const SleepRule rule = Parse("*.example.com");
  EXPECT_TRUE(Match("https://app.example.com/", rule));
  EXPECT_TRUE(Match("https://a.b.example.com/", rule));
  EXPECT_FALSE(Match("https://example.com/", rule));
}

TEST(SleepRulesTest, HostIsExact) {
  const SleepRule rule = Parse("=docs.google.com");
  EXPECT_TRUE(Match("https://docs.google.com/document", rule));
  EXPECT_FALSE(Match("https://sheets.google.com/", rule));
  EXPECT_FALSE(Match("https://other.docs.google.com/", rule));
}

TEST(SleepRulesTest, UrlPrefixMatchesDescendants) {
  const SleepRule rule = Parse("https://github.com/neel");
  EXPECT_TRUE(Match("https://github.com/neel/still", rule));
  EXPECT_TRUE(Match("https://github.com/neel", rule));
  EXPECT_FALSE(Match("https://github.com/other/repo", rule));
}

TEST(SleepRulesTest, PathPrefixWithoutScheme) {
  const SleepRule rule = Parse("github.com/neel");
  EXPECT_TRUE(Match("https://github.com/neel/still", rule));
  EXPECT_FALSE(Match("https://github.com/neelisha", rule));
}

TEST(SleepRulesTest, ScansAListOfRules) {
  const std::vector<SleepRule> rules = {Parse("mail.google.com"),
                                        Parse("*.figma.com")};
  EXPECT_TRUE(MatchesAny(GURL("https://mail.google.com/mail"), rules));
  EXPECT_FALSE(MatchesAny(GURL("https://www.figma.com/file/x"), rules));
  EXPECT_TRUE(MatchesAny(GURL("https://app.figma.com/file/x"), rules));
  EXPECT_FALSE(MatchesAny(GURL("https://news.ycombinator.com/"), rules));
}

TEST(SleepRulesTest, ExactUrlAndBrowserPages) {
  const SleepRule rule{Kind::kUrl, "https://example.com/a/"};
  EXPECT_TRUE(Match("https://example.com/a", rule));
  EXPECT_FALSE(Match("https://example.com/a/b", rule));
  EXPECT_FALSE(Match("chrome://settings", Parse("settings.com")));
}

TEST(SleepRulesTest, RoundTripsThroughThePref) {
  const std::vector<SleepRule> rules = {Parse("example.com"),
                                        Parse("=a.example.com"),
                                        Parse("github.com/neel")};
  EXPECT_EQ(RulesFromList(RulesToList(rules)), rules);
  base::ListValue junk;
  junk.Append(1);
  junk.Append(base::DictValue().Set("kind", "nope").Set("pattern", "x.com"));
  EXPECT_TRUE(RulesFromList(junk).empty());
}

}  // namespace
}  // namespace perch
