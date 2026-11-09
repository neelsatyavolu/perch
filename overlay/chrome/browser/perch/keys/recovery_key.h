// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_KEYS_RECOVERY_KEY_H_
#define CHROME_BROWSER_PERCH_KEYS_RECOVERY_KEY_H_

#include <array>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/containers/span.h"

namespace perch {

// The recovery key (spec 11.1) is the profile's 32-byte root key in Crockford
// base32, in dashed groups of five, for writing down. It reopens everything
// Perch sealed for the profile, on this Mac or another one.
std::string FormatRecoveryKey(base::span<const uint8_t> key);

// Reads a typed recovery key: any case, spaces and dashes, and the letters
// Crockford base32 reads as digits (O as 0, I and L as 1). Nullopt unless it
// is exactly 32 bytes.
std::optional<std::vector<uint8_t>> ParseRecoveryKey(std::string_view text);

// What `<profile>/Perch Agent/root.check` holds: an HMAC of a fixed label
// under the root key, in hex. It tells whether a typed recovery key is the one
// this profile's data needs, without storing anything that reveals the key.
std::string RootCheck(base::span<const uint8_t> key);

// The key that encrypts backups of the profile (HKDF-SHA256 of the root key).
std::array<uint8_t, 32> BackupKey(base::span<const uint8_t> key);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_KEYS_RECOVERY_KEY_H_
