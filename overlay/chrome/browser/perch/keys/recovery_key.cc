// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/recovery_key.h"

#include "base/containers/span.h"
#include "base/strings/string_number_conversions.h"
#include "crypto/hash.h"
#include "crypto/hmac.h"
#include "crypto/kdf.h"

namespace perch {

namespace {

constexpr std::string_view kAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
constexpr size_t kRootKeySize = 32;

std::optional<uint32_t> DigitValue(char c) {
  if (c >= 'a' && c <= 'z') {
    c = static_cast<char>(c - 'a' + 'A');
  }
  switch (c) {
    case 'O':
      return 0;
    case 'I':
    case 'L':
      return 1;
    default:
      break;
  }
  const size_t pos = kAlphabet.find(c);
  if (pos == std::string_view::npos) {
    return std::nullopt;
  }
  return static_cast<uint32_t>(pos);
}

}  // namespace

std::string FormatRecoveryKey(base::span<const uint8_t> key) {
  std::string out;
  int bits = 0;
  uint32_t buffer = 0;
  for (uint8_t byte : key) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out.push_back(kAlphabet[(buffer >> (bits - 5)) & 31]);
      bits -= 5;
    }
  }
  if (bits > 0) {
    out.push_back(kAlphabet[(buffer << (5 - bits)) & 31]);
  }
  std::string grouped;
  for (size_t i = 0; i < out.size(); ++i) {
    if (i && i % 5 == 0) {
      grouped.push_back('-');
    }
    grouped.push_back(out[i]);
  }
  return grouped;
}

std::optional<std::vector<uint8_t>> ParseRecoveryKey(std::string_view text) {
  std::vector<uint8_t> out;
  int bits = 0;
  uint32_t buffer = 0;
  for (char c : text) {
    if (c == '-' || c == ' ' || c == '\t' || c == '\n' || c == '\r') {
      continue;
    }
    std::optional<uint32_t> digit = DigitValue(c);
    if (!digit) {
      return std::nullopt;
    }
    buffer = (buffer << 5) | *digit;
    bits += 5;
    if (bits >= 8) {
      out.push_back(static_cast<uint8_t>(buffer >> (bits - 8)));
      bits -= 8;
    }
    if (out.size() > kRootKeySize) {
      return std::nullopt;
    }
  }
  // 52 digits carry 260 bits: 256 for the key and 4 that must be zero.
  if (out.size() != kRootKeySize || bits >= 5 ||
      (buffer & ((1u << bits) - 1)) != 0) {
    return std::nullopt;
  }
  return out;
}

std::string RootCheck(base::span<const uint8_t> key) {
  return base::HexEncodeLower(
      crypto::hmac::SignSha256(key, base::as_byte_span(std::string_view(
                                        "perch/root-check/v1"))));
}

std::array<uint8_t, 32> BackupKey(base::span<const uint8_t> key) {
  return crypto::kdf::Hkdf<32>(
      crypto::hash::kSha256, key, {},
      base::as_byte_span(std::string_view("perch/backup/v1")));
}

}  // namespace perch
