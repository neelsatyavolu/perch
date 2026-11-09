// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/recovery_key.h"

#include <string>
#include <vector>

#include "base/strings/string_util.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace perch {
namespace {

std::vector<uint8_t> SampleKey() {
  std::vector<uint8_t> key(32);
  for (size_t i = 0; i < key.size(); ++i) {
    key[i] = static_cast<uint8_t>(i * 37 + 11);
  }
  return key;
}

TEST(RecoveryKeyTest, FormatsInGroupsOfFive) {
  const std::string text = FormatRecoveryKey(SampleKey());
  // 52 digits: ten groups of five and one of two.
  EXPECT_EQ(text.size(), 52u + 10u);
  EXPECT_EQ(text[5], '-');
  EXPECT_EQ(text.find_first_of("ILOU"), std::string::npos);
}

TEST(RecoveryKeyTest, RoundTripsAndForgivesHowItWasTyped) {
  const std::vector<uint8_t> key = SampleKey();
  const std::string text = FormatRecoveryKey(key);
  EXPECT_EQ(ParseRecoveryKey(text), key);
  std::string sloppy = base::ToLowerASCII(text);
  base::ReplaceChars(sloppy, "-", " ", &sloppy);
  EXPECT_EQ(ParseRecoveryKey(sloppy), key);
  std::string no_dashes;
  base::RemoveChars(text, "-", &no_dashes);
  EXPECT_EQ(ParseRecoveryKey(no_dashes), key);
}

TEST(RecoveryKeyTest, ReadsLookalikeLettersAsDigits) {
  const std::vector<uint8_t> zeros(32, 0);
  const std::string text = FormatRecoveryKey(zeros);
  std::string with_o = text;
  base::ReplaceChars(with_o, "0", "O", &with_o);
  EXPECT_EQ(ParseRecoveryKey(with_o), zeros);
}

TEST(RecoveryKeyTest, RejectsWrongLengthsAndLetters) {
  const std::string text = FormatRecoveryKey(SampleKey());
  EXPECT_FALSE(ParseRecoveryKey(""));
  EXPECT_FALSE(ParseRecoveryKey(text.substr(0, text.size() - 1)));
  EXPECT_FALSE(ParseRecoveryKey(text + "0"));
  EXPECT_FALSE(ParseRecoveryKey(text.substr(0, 10) + "U" + text.substr(11)));
}

TEST(RecoveryKeyTest, CheckAndBackupKeyDependOnTheKey) {
  std::vector<uint8_t> other = SampleKey();
  other[0] ^= 1;
  EXPECT_EQ(RootCheck(SampleKey()), RootCheck(SampleKey()));
  EXPECT_NE(RootCheck(SampleKey()), RootCheck(other));
  EXPECT_EQ(RootCheck(SampleKey()).size(), 64u);
  EXPECT_NE(BackupKey(SampleKey()), BackupKey(other));
}

}  // namespace
}  // namespace perch
