// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_KEYS_RESTORE_FLOW_H_
#define CHROME_BROWSER_PERCH_KEYS_RESTORE_FLOW_H_

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback_forward.h"

namespace perch {

// Backup and restore for Settings and the welcome page (spec 11.1). One runs
// at a time; perchd is stopped while files move and started again after.

struct RestoreRequest {
  base::FilePath profile_dir;
  // From the person's recovery key.
  std::vector<uint8_t> key;
  // A backup file to restore too, or nullopt to restore the key only.
  std::optional<base::FilePath> backup;
  // The person confirmed replacing data made with a different key. That data
  // is kept beside the restored folder, and only its own recovery key opens
  // it.
  bool replace_data = false;
};

// Order: check everything without changing anything, store the key, then put
// the backup's files in place (putting the old key back if that fails).
// Replies nullopt when restored, else one of "wrong-key", "bad-backup",
// "replaces-data", "busy", "unavailable" or "failed".
void RunRestore(RestoreRequest request,
                base::OnceCallback<void(std::optional<std::string>)> done);

// Writes the profile's encrypted backup to `dest`. Replies nullopt when
// saved, else "busy" or "failed".
void RunExport(base::FilePath profile_dir,
               std::vector<uint8_t> key,
               base::FilePath dest,
               base::OnceCallback<void(std::optional<std::string>)> done);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_KEYS_RESTORE_FLOW_H_
