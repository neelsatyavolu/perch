// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webkit_tab/webkit_tab_rules.h"

#include "testing/gtest/include/gtest/gtest.h"
#include "url/gurl.h"

namespace perch {
namespace {

TEST(PerchWebKitTabRulesTest, NetflixAndSubdomainsUseWebKit) {
  EXPECT_TRUE(UsesWebKit(GURL("https://netflix.com/")));
  EXPECT_TRUE(UsesWebKit(GURL("https://www.netflix.com/watch/80117807")));
  EXPECT_TRUE(UsesWebKit(GURL("https://help.netflix.com/en/node/30081")));
  EXPECT_TRUE(UsesWebKit(GURL("https://WWW.NETFLIX.COM./browse")));
}

TEST(PerchWebKitTabRulesTest, OtherSitesStayInChromium) {
  EXPECT_FALSE(UsesWebKit(GURL("https://notnetflix.com/")));
  EXPECT_FALSE(UsesWebKit(GURL("https://netflix.com.evil.example/")));
  EXPECT_FALSE(UsesWebKit(GURL("https://www.youtube.com/")));
  EXPECT_FALSE(UsesWebKit(GURL("perch://settings/")));
  EXPECT_FALSE(UsesWebKit(GURL()));
}

TEST(PerchWebKitTabRulesTest, PlainHttpIsNotRouted) {
  // Netflix upgrades to https itself; routing http would hide that hop.
  EXPECT_FALSE(UsesWebKit(GURL("http://www.netflix.com/")));
}

TEST(PerchWebKitTabRulesTest, PlaceholderIsATinyStaticPage) {
  const std::string html = PlaceholderHtml();
  EXPECT_NE(html.find("<!doctype html>"), std::string::npos);
  EXPECT_EQ(html.find("<script"), std::string::npos);
  EXPECT_LT(html.size(), 1024u);
}

}  // namespace
}  // namespace perch
