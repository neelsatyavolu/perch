// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_KEYS_KEY_BROKER_H_
#define CHROME_BROWSER_PERCH_KEYS_KEY_BROKER_H_

#include <map>
#include <optional>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"

class Profile;

namespace perch {

// Each profile's 32-byte root key (plan 3b task 3). The signed Perch Keys
// helper keeps it wrapped by a Secure Enclave key; the broker asks it for the
// key ("get", or "create" the first time), keeps it in memory, and hands it
// to perchd on its settings pipe:
//   {op:"profile", id, dir, key, protected, recovery?}
// Without the helper (development builds) nothing is sent, and perchd keeps
// using the Keychain.
class KeyBroker {
 public:
  // Writes one line to perchd's settings pipe.
  using LineSender = base::RepeatingCallback<void(std::string)>;

  struct Entry {
    std::vector<uint8_t> key;
    bool is_protected = false;
    // Sent once, when the helper made the key.
    std::string recovery;
  };

  static KeyBroker& Get();

  KeyBroker(const KeyBroker&) = delete;
  KeyBroker& operator=(const KeyBroker&) = delete;

  // perchd (re)started: send it every key we know, and fetch the rest.
  void OnPerchdLaunched(LineSender sender);
  // A profile is open: make sure perchd gets its key.
  void EnsureProfile(Profile* profile);

  // The root key of the profile in `profile_dir`, once fetched.
  std::optional<std::vector<uint8_t>> RootKeyFor(
      const base::FilePath& profile_dir) const;

 private:
  friend class base::NoDestructor<KeyBroker>;

  KeyBroker();
  ~KeyBroker();

  void Fetch(const base::FilePath& profile_dir);
  void OnFetched(base::FilePath profile_dir, std::optional<Entry> entry);
  void Send(const base::FilePath& profile_dir, const Entry& entry);

  LineSender sender_;
  std::map<base::FilePath, Entry> keys_;
  std::vector<base::FilePath> pending_;
  base::WeakPtrFactory<KeyBroker> weak_factory_{this};
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_KEYS_KEY_BROKER_H_
