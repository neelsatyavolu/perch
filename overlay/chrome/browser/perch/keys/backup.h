// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_KEYS_BACKUP_H_
#define CHROME_BROWSER_PERCH_KEYS_BACKUP_H_

#include <cstdint>
#include <optional>

#include "base/containers/span.h"
#include "base/files/file_path.h"
#include "base/types/expected.h"

namespace perch {

// "Export everything" (spec 11.1): one file holding everything perchd keeps
// for a profile (its `Perch Agent` folder), zipped and sealed with AES-256-GCM
// under a key derived from the root key, so the recovery key alone opens it.
// File: "PERCHBK1", a 12-byte nonce, then the sealed zip.
//
// Everything here blocks: call it on a MayBlock sequence, with perchd stopped
// (PerchdLauncher::Pause) so its files hold still.

enum class BackupError {
  kWrongKey,   // The key doesn't open it.
  kBadBackup,  // Not a Perch backup, or cut short.
  kFailed,     // Disk or zip trouble.
};

// The profile folder's `Perch Agent`.
base::FilePath AgentDir(const base::FilePath& profile_dir);

// Writes the backup to a temporary file beside `dest`, then renames it, so a
// failure never spoils a file that was there.
bool WriteBackup(const base::FilePath& profile_dir,
                 base::span<const uint8_t> root_key,
                 const base::FilePath& dest);

// Opens `src` with `root_key` and unpacks it into a new folder inside the
// profile folder, changing nothing else. Returns that folder; it holds a
// `Perch Agent` ready for SwapInRestored.
base::expected<base::FilePath, BackupError> UnpackBackup(
    const base::FilePath& profile_dir,
    base::span<const uint8_t> root_key,
    const base::FilePath& src);

// Puts `staging`'s `Perch Agent` in place. The folder it replaces is kept as
// "Perch Agent (before restore <time>)"; false, with everything as it was,
// when a move fails. `staging` is deleted either way.
bool SwapInRestored(const base::FilePath& profile_dir,
                    const base::FilePath& staging);

// Moves the profile's `Perch Agent` to "Perch Agent (set aside <time>)".
// True when there was nothing to move.
bool SetAgentDataAside(const base::FilePath& profile_dir);

// Whether `root_key` is the key the profile's data was made with, from
// `Perch Agent/root.check`: nullopt when there is no check file, false when it
// doesn't match or can't be read.
std::optional<bool> CheckRootKey(const base::FilePath& profile_dir,
                                 base::span<const uint8_t> root_key);
// Writes the check file if it is missing.
void EnsureRootCheck(const base::FilePath& profile_dir,
                     base::span<const uint8_t> root_key);
// Whether the profile has Perch data made with some key: the check file, or
// sealed secrets from builds before it.
bool HasKeyedData(const base::FilePath& profile_dir);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_KEYS_BACKUP_H_
