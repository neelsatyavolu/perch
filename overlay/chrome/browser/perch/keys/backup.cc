// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/backup.h"

#include <algorithm>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/containers/span.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "chrome/browser/perch/keys/recovery_key.h"
#include "crypto/aead.h"
#include "crypto/random.h"
#include "third_party/zlib/google/zip.h"

namespace perch {

namespace {

constexpr std::string_view kMagic = "PERCHBK1";
constexpr size_t kNonceSize = 12;
constexpr char kCheckFile[] = "root.check";
constexpr char kSecretsDir[] = "secrets";

base::span<const uint8_t> MagicBytes() {
  return base::as_byte_span(kMagic);
}

// "Perch Agent (before restore 2026-11-08 18-40-12)", or with a number when
// that exists too, so one restore never removes what an earlier one kept.
base::FilePath KeptFolder(const base::FilePath& profile_dir) {
  base::Time::Exploded now;
  base::Time::Now().LocalExplode(&now);
  const std::string stamp =
      base::StringPrintf("%04d-%02d-%02d %02d-%02d-%02d", now.year, now.month,
                         now.day_of_month, now.hour, now.minute, now.second);
  base::FilePath kept =
      profile_dir.Append("Perch Agent (before restore " + stamp + ")");
  for (int i = 2; base::PathExists(kept); ++i) {
    kept = profile_dir.Append("Perch Agent (before restore " + stamp + " " +
                              base::NumberToString(i) + ")");
  }
  return kept;
}

}  // namespace

base::FilePath AgentDir(const base::FilePath& profile_dir) {
  return profile_dir.Append("Perch Agent");
}

bool WriteBackup(const base::FilePath& profile_dir,
                 base::span<const uint8_t> root_key,
                 const base::FilePath& dest) {
  const base::FilePath agent = AgentDir(profile_dir);
  if (!base::DirectoryExists(agent)) {
    return false;
  }
  EnsureRootCheck(profile_dir, root_key);
  base::ScopedTempDir temp;
  if (!temp.CreateUniqueTempDir()) {
    return false;
  }
  const base::FilePath zip_path = temp.GetPath().Append("backup.zip");
  // Lock files belong to a running perchd, not to the data.
  if (!zip::ZipWithFilterCallback(
          agent, zip_path, base::BindRepeating([](const base::FilePath& path) {
            return !base::EndsWith(path.value(), ".lock");
          }))) {
    return false;
  }
  std::optional<std::vector<uint8_t>> plain = base::ReadFileToBytes(zip_path);
  if (!plain) {
    return false;
  }
  const std::array<uint8_t, 32> key = BackupKey(root_key);
  const std::vector<uint8_t> nonce = crypto::RandBytesAsVector(kNonceSize);
  std::vector<uint8_t> file(MagicBytes().begin(), MagicBytes().end());
  file.insert(file.end(), nonce.begin(), nonce.end());
  {
    const std::vector<uint8_t> sealed = crypto::aead::Seal(
        crypto::aead::AES_256_GCM, key, *plain, nonce, MagicBytes());
    if (sealed.empty()) {
      return false;
    }
    file.insert(file.end(), sealed.begin(), sealed.end());
  }
  std::ranges::fill(*plain, 0);
  const base::FilePath partial = dest.AddExtension(".partial");
  if (!base::WriteFile(partial, file)) {
    base::DeleteFile(partial);
    return false;
  }
  return base::ReplaceFile(partial, dest, nullptr);
}

base::expected<base::FilePath, BackupError> UnpackBackup(
    const base::FilePath& profile_dir,
    base::span<const uint8_t> root_key,
    const base::FilePath& src) {
  std::optional<std::vector<uint8_t>> file = base::ReadFileToBytes(src);
  if (!file || file->size() <= kMagic.size() + kNonceSize ||
      !std::equal(MagicBytes().begin(), MagicBytes().end(), file->begin())) {
    return base::unexpected(BackupError::kBadBackup);
  }
  const base::span<const uint8_t> bytes(*file);
  const std::array<uint8_t, 32> key = BackupKey(root_key);
  std::optional<std::vector<uint8_t>> plain = crypto::aead::Open(
      crypto::aead::AES_256_GCM, key,
      bytes.subspan(kMagic.size() + kNonceSize),
      bytes.subspan(kMagic.size(), kNonceSize), MagicBytes());
  if (!plain) {
    return base::unexpected(BackupError::kWrongKey);
  }
  // Inside the profile folder, so the later move stays on one volume.
  base::FilePath staging;
  if (!base::CreateTemporaryDirInDir(profile_dir, "perch-restore-",
                                     &staging)) {
    return base::unexpected(BackupError::kFailed);
  }
  const base::FilePath zip_path = staging.Append("backup.zip");
  const bool unpacked = base::WriteFile(zip_path, *plain) &&
                        zip::Unzip(zip_path, staging.Append("Perch Agent"));
  std::ranges::fill(*plain, 0);
  base::DeleteFile(zip_path);
  if (!unpacked) {
    base::DeletePathRecursively(staging);
    return base::unexpected(BackupError::kBadBackup);
  }
  return staging;
}

bool SwapInRestored(const base::FilePath& profile_dir,
                    const base::FilePath& staging) {
  const base::FilePath agent = AgentDir(profile_dir);
  const base::FilePath kept = KeptFolder(profile_dir);
  bool ok = true;
  const bool had_data = base::DirectoryExists(agent);
  if (had_data && !base::Move(agent, kept)) {
    ok = false;
  } else if (!base::Move(staging.Append("Perch Agent"), agent)) {
    if (had_data) {
      base::Move(kept, agent);
    }
    ok = false;
  }
  base::DeletePathRecursively(staging);
  return ok;
}

std::optional<bool> CheckRootKey(const base::FilePath& profile_dir,
                                 base::span<const uint8_t> root_key) {
  const base::FilePath check = AgentDir(profile_dir).Append(kCheckFile);
  if (!base::PathExists(check)) {
    return std::nullopt;
  }
  std::string stored;
  if (!base::ReadFileToString(check, &stored)) {
    return false;
  }
  return base::TrimWhitespaceASCII(stored, base::TRIM_ALL) ==
         RootCheck(root_key);
}

void EnsureRootCheck(const base::FilePath& profile_dir,
                     base::span<const uint8_t> root_key) {
  const base::FilePath agent = AgentDir(profile_dir);
  const base::FilePath check = agent.Append(kCheckFile);
  if (base::PathExists(check) || !base::CreateDirectory(agent)) {
    return;
  }
  base::WriteFile(check, RootCheck(root_key) + "\n");
}

bool HasKeyedData(const base::FilePath& profile_dir) {
  const base::FilePath agent = AgentDir(profile_dir);
  return base::PathExists(agent.Append(kCheckFile)) ||
         !base::IsDirectoryEmpty(agent.Append(kSecretsDir));
}

}  // namespace perch
