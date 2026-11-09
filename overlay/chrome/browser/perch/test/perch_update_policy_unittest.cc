// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/perch_update_policy.h"

#include "base/time/time.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace perch {
namespace {

base::Time Day(int day) {
  return base::Time::UnixEpoch() + base::Days(day);
}

TEST(PerchUpdatePolicyTest, DefaultsOfferEveryStableUpdateRightAway) {
  const UpdatePolicy policy;
  EXPECT_TRUE(ShouldOffer(policy, Day(10), "", Day(10)));
  EXPECT_TRUE(ShouldOffer(policy, Day(10), "stable", Day(10)));
  EXPECT_FALSE(ShouldOffer(policy, Day(10), "beta", Day(10)));
}

TEST(PerchUpdatePolicyTest, BetaMacsAlsoGetStable) {
  UpdatePolicy policy;
  policy.channel = "beta";
  EXPECT_TRUE(ShouldOffer(policy, Day(10), "beta", Day(10)));
  EXPECT_TRUE(ShouldOffer(policy, Day(10), "", Day(10)));
}

TEST(PerchUpdatePolicyTest, DelayHoldsAnUpdateBack) {
  UpdatePolicy policy;
  policy.delay_days = 7;
  EXPECT_FALSE(ShouldOffer(policy, Day(10), "", Day(16)));
  EXPECT_TRUE(ShouldOffer(policy, Day(10), "", Day(17)));
}

TEST(PerchUpdatePolicyTest, MinimumVersion) {
  UpdatePolicy policy;
  EXPECT_FALSE(BelowMinimumVersion(policy, "158.0.8127.18"));
  policy.minimum_version = "158.0.8127.20";
  EXPECT_TRUE(BelowMinimumVersion(policy, "158.0.8127.18"));
  EXPECT_FALSE(BelowMinimumVersion(policy, "158.0.8127.20"));
  EXPECT_FALSE(BelowMinimumVersion(policy, "159.0.1.0"));
  EXPECT_FALSE(BelowMinimumVersion(policy, "not a version"));
}

}  // namespace
}  // namespace perch
