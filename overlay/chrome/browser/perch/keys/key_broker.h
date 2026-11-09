// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_KEYS_KEY_BROKER_H_
#define CHROME_BROWSER_PERCH_KEYS_KEY_BROKER_H_

#include <map>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/scoped_observation.h"
#include "base/types/expected.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/profiles/profile_manager_observer.h"

class BrowserWindowInterface;
class Profile;

namespace perch {

// Each profile's 32-byte root key (plan 3b task 3). The signed Perch Keys
// helper keeps it wrapped by a Secure Enclave key; the broker asks it for the
// key ("get", or "create" the first time), keeps it in memory, and hands it
// to perchd on its settings pipe:
//   {op:"profile", id, dir, key, protected, recovery?}
// Without the helper (development builds) nothing is sent, and perchd keeps
// using the Keychain.
class KeyBroker : public ProfileManagerObserver {
 public:
  // Writes one line to perchd's settings pipe.
  using LineSender = base::RepeatingCallback<void(std::string)>;

  struct Entry {
    std::vector<uint8_t> key;
    bool is_protected = false;
    // Sent once, when the helper made the key.
    std::string recovery;
  };

  // What one fetch found: the key, or that the profile needs a restore.
  struct Fetched {
    std::optional<Entry> entry;
    bool needs_restore = false;
    bool helper_available = false;
  };

  static KeyBroker& Get();

  KeyBroker(const KeyBroker&) = delete;
  KeyBroker& operator=(const KeyBroker&) = delete;

  // perchd (re)started: send it every key we know, and fetch the rest.
  void OnPerchdLaunched(LineSender sender);
  // perchd stopped: nothing more goes to its old pipe.
  void OnPerchdStopped() { sender_.Reset(); }
  // A profile is open: make sure perchd gets its key.
  void EnsureProfile(Profile* profile);

  // Whether keys are wrapped by the Secure Enclave (false for the software key
  // of builds without the provisioning profile).
  bool IsProtected(const base::FilePath& profile_dir) const;
  // The profile has Perch data but this Mac has no key for it (Migration
  // Assistant doesn't carry Secure Enclave keys): restore from the recovery
  // key. Perch opens perch://welcome#restore when it finds this.
  bool NeedsRestore(const base::FilePath& profile_dir) const;
  // The profile's old data was set aside (keys/restore_flow.h): forget that
  // it needed a restore and fetch, which makes a new key.
  void StartFresh(const base::FilePath& profile_dir);
  // A browser window opened: shows the restore page there if a profile was
  // waiting for a window to show it in.
  void OnWindowOpened(BrowserWindowInterface* browser);
  // Whether this build has the Perch Keys helper, as the last key fetch found
  // (it looks on disk off the UI thread).
  bool HelperAvailable() const { return helper_available_; }

  // Stores `root_key` (from the person's recovery key) as the profile's key
  // and hands it to perchd. Checking it against the data is the caller's job
  // (keys/restore_flow.h). Fails with "unavailable" without the helper, else
  // "failed".
  void ImportRootKey(
      const base::FilePath& profile_dir,
      std::vector<uint8_t> root_key,
      base::OnceCallback<void(std::optional<std::string> error)> done);

  // The root key of the profile in `profile_dir`, once fetched.
  std::optional<std::vector<uint8_t>> RootKeyFor(
      const base::FilePath& profile_dir) const;

  // ProfileManagerObserver: a new profile gets its key, and a deleted one is
  // forgotten here and in perchd ({op:"profile-removed", id}).
  void OnProfileAdded(Profile* profile) override;
  void OnProfileMarkedForPermanentDeletion(Profile* profile) override;
  void OnProfileManagerDestroying() override;

 private:
  friend class base::NoDestructor<KeyBroker>;

  KeyBroker();
  ~KeyBroker() override;

  void Fetch(const base::FilePath& profile_dir);
  void OnFetched(base::FilePath profile_dir, Fetched fetched);
  void OnRestored(base::FilePath profile_dir,
                  base::OnceCallback<void(std::optional<std::string>)> done,
                  base::expected<Entry, std::string> result);
  void Send(const base::FilePath& profile_dir, const Entry& entry);

  LineSender sender_;
  std::map<base::FilePath, Entry> keys_;
  std::vector<base::FilePath> pending_;
  std::set<base::FilePath> needs_restore_;
  std::set<base::FilePath> restore_page_waiting_;
  bool helper_available_ = false;
  base::ScopedObservation<ProfileManager, ProfileManagerObserver>
      observation_{this};
  base::WeakPtrFactory<KeyBroker> weak_factory_{this};
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_KEYS_KEY_BROKER_H_
