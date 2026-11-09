// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/backup.h"

#include <string>
#include <vector>

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace perch {
namespace {

std::vector<uint8_t> Key(uint8_t seed) {
  return std::vector<uint8_t>(32, seed);
}

class BackupTest : public testing::Test {
 protected:
  void SetUp() override {
    ASSERT_TRUE(temp_.CreateUniqueTempDir());
    profile_ = temp_.GetPath().Append("Default");
    const base::FilePath agent = AgentDir(profile_);
    ASSERT_TRUE(base::CreateDirectory(agent.Append("memory")));
    ASSERT_TRUE(base::WriteFile(agent.Append("memory").Append("page.md"), "hello"));
    ASSERT_TRUE(base::WriteFile(agent.Append("perchd.lock"), "1234"));
  }

  std::string Read(const base::FilePath& path) {
    std::string text;
    base::ReadFileToString(path, &text);
    return text;
  }

  base::ScopedTempDir temp_;
  base::FilePath profile_;
};

TEST_F(BackupTest, RoundTripsWithTheRightKeyOnly) {
  const base::FilePath file = temp_.GetPath().Append("backup.perchbackup");
  ASSERT_TRUE(WriteBackup(profile_, Key(1), file));
  EXPECT_EQ(Read(file).substr(0, 8), "PERCHBK1");
  EXPECT_EQ(Read(file).find("hello"), std::string::npos);
  EXPECT_FALSE(base::PathExists(file.AddExtension(".partial")));

  // A new Mac: an empty profile.
  const base::FilePath fresh = temp_.GetPath().Append("Fresh");
  ASSERT_TRUE(base::CreateDirectory(fresh));
  EXPECT_EQ(UnpackBackup(fresh, Key(2), file).error(), BackupError::kWrongKey);
  EXPECT_FALSE(base::PathExists(AgentDir(fresh)));

  base::expected<base::FilePath, BackupError> staged =
      UnpackBackup(fresh, Key(1), file);
  ASSERT_TRUE(staged.has_value());
  // Unpacking changes nothing in place.
  EXPECT_FALSE(base::PathExists(AgentDir(fresh)));
  ASSERT_TRUE(SwapInRestored(fresh, *staged));
  EXPECT_FALSE(base::PathExists(*staged));
  EXPECT_EQ(Read(AgentDir(fresh).Append("memory").Append("page.md")), "hello");
  // The running perchd's lock isn't part of the data.
  EXPECT_FALSE(base::PathExists(AgentDir(fresh).Append("perchd.lock")));
  EXPECT_EQ(CheckRootKey(fresh, Key(1)), true);
  EXPECT_EQ(CheckRootKey(fresh, Key(2)), false);
}

TEST_F(BackupTest, EachRestoreKeepsWhatItReplaced) {
  const base::FilePath file = temp_.GetPath().Append("b.perchbackup");
  ASSERT_TRUE(WriteBackup(profile_, Key(1), file));
  ASSERT_TRUE(base::WriteFile(AgentDir(profile_).Append("newer.md"), "x"));
  for (int i = 0; i < 2; ++i) {
    base::expected<base::FilePath, BackupError> staged =
        UnpackBackup(profile_, Key(1), file);
    ASSERT_TRUE(staged.has_value());
    ASSERT_TRUE(SwapInRestored(profile_, *staged));
  }
  EXPECT_FALSE(base::PathExists(AgentDir(profile_).Append("newer.md")));
  // Two restores, two kept folders: the first still has the newer file.
  int kept = 0;
  bool newer_kept = false;
  base::FileEnumerator folders(profile_, false,
                               base::FileEnumerator::DIRECTORIES,
                               FILE_PATH_LITERAL("Perch Agent (before restore*"));
  for (base::FilePath dir = folders.Next(); !dir.empty(); dir = folders.Next()) {
    ++kept;
    newer_kept |= base::PathExists(dir.Append("newer.md"));
  }
  EXPECT_EQ(kept, 2);
  EXPECT_TRUE(newer_kept);
}

TEST_F(BackupTest, OverwritesAnEarlierBackupOnlyWhenWhole) {
  const base::FilePath file = temp_.GetPath().Append("b.perchbackup");
  ASSERT_TRUE(base::WriteFile(file, "older"));
  ASSERT_TRUE(WriteBackup(profile_, Key(1), file));
  EXPECT_EQ(Read(file).substr(0, 8), "PERCHBK1");
}

TEST_F(BackupTest, RefusesFilesThatArentBackups) {
  const base::FilePath junk = temp_.GetPath().Append("junk");
  ASSERT_TRUE(base::WriteFile(junk, "not a backup at all"));
  EXPECT_EQ(UnpackBackup(profile_, Key(1), junk).error(),
            BackupError::kBadBackup);
  EXPECT_EQ(
      UnpackBackup(profile_, Key(1), temp_.GetPath().Append("none")).error(),
      BackupError::kBadBackup);
}

TEST_F(BackupTest, RootCheckIsWrittenOnceAndChecksKeys) {
  EXPECT_FALSE(HasKeyedData(profile_));
  EXPECT_EQ(CheckRootKey(profile_, Key(9)), std::nullopt);
  EnsureRootCheck(profile_, Key(1));
  EXPECT_TRUE(HasKeyedData(profile_));
  EnsureRootCheck(profile_, Key(2));
  EXPECT_EQ(CheckRootKey(profile_, Key(1)), true);
  EXPECT_EQ(CheckRootKey(profile_, Key(2)), false);
}

TEST_F(BackupTest, SealedSecretsWithoutACheckStillCountAsKeyedData) {
  const base::FilePath secrets = AgentDir(profile_).Append("secrets");
  ASSERT_TRUE(base::CreateDirectory(secrets));
  EXPECT_FALSE(HasKeyedData(profile_));
  ASSERT_TRUE(base::WriteFile(secrets.Append("app.sealed"), "x"));
  EXPECT_TRUE(HasKeyedData(profile_));
}

}  // namespace
}  // namespace perch
