// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_KEYS_PERCH_KEYS_HOST_H_
#define CHROME_BROWSER_PERCH_KEYS_PERCH_KEYS_HOST_H_

#include <memory>
#include <string>

namespace content {
class BrowserContext;
}

namespace extensions {
class NativeMessageHost;
}

namespace perch {

inline constexpr char kPerchKeysHostName[] = "co.xanom.perch.keys";

// The browser's own native messaging host for the Perch extension (plan 3b
// task 4). {op:"authenticator"} answers {key: base64 HKDF(root key, info
// "perch/authenticator/v1")}: the same 32 bytes every launch, so the
// authenticator's secrets stay readable. Only the Perch extension may connect,
// never from a private profile. Returns null with `error` set otherwise.
std::unique_ptr<extensions::NativeMessageHost> CreatePerchKeysHost(
    content::BrowserContext* context,
    const std::string& extension_id,
    std::string* error);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_KEYS_PERCH_KEYS_HOST_H_
