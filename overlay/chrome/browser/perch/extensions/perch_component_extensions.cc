// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/extensions/perch_component_extensions.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>

#include "base/apple/bundle_locations.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/weak_ptr.h"
#include "base/supports_user_data.h"
#include "base/values.h"
#include "chrome/browser/extensions/component_loader.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "extensions/browser/extension_file_task_runner.h"
#include "extensions/common/file_util.h"

namespace perch {

namespace {

struct BuiltIn {
  const char* name;
  const char* id;
  const char* pref;
};

// The ids follow from the public keys in build/bundled-extensions.json, which
// perch-build writes into each staged manifest.
constexpr BuiltIn kBuiltIns[] = {
    {"perch", kPerchExtensionId, prefs::kExtensionPerchEnabled},
    {"backrow", "ajhempjobmeelmhloiiecnbljbpoohcc",
     prefs::kExtensionBackrowEnabled},
    {"lulltab", "cajablldnlcmhamlhpbjdapikiakdjdm",
     prefs::kExtensionLulltabEnabled},
    {"caveatly", "mefnjppdmliabfgljepbdgdalmgggmid",
     prefs::kExtensionCaveatlyEnabled},
};

constexpr char kWatcherKey[] = "perch.component_extensions";

base::FilePath ExtensionsDir() {
  base::FilePath dir =
      base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(
          kExtensionsDirSwitch);
  if (!dir.empty()) {
    return dir;
  }
  return base::apple::FrameworkBundlePath()
      .Append("Resources")
      .Append("perch_extensions");
}

// Runs on the extension file task runner.
std::optional<base::DictValue> ReadManifest(const base::FilePath& dir) {
  std::string error;
  std::optional<base::DictValue> manifest =
      extensions::file_util::LoadManifest(dir, &error);
  if (!manifest) {
    LOG(ERROR) << "Perch: can't load the built-in extension in " << dir
               << ": " << error;
  }
  return manifest;
}

// Keeps each built-in extension in step with its pref for one profile. It
// stops watching when the profile starts to go away, before its prefs do.
class Watcher : public base::SupportsUserData::Data, public ProfileObserver {
 public:
  explicit Watcher(Profile* profile) : profile_(profile) {
    profile->AddObserver(this);
    registrar_.Init(profile->GetPrefs());
    for (const BuiltIn& builtin : kBuiltIns) {
      registrar_.Add(builtin.pref,
                     base::BindRepeating(&Watcher::Sync,
                                         weak_factory_.GetWeakPtr(), builtin));
    }
  }

  ~Watcher() override {
    if (profile_) {
      profile_->RemoveObserver(this);
    }
  }

  // ProfileObserver:
  void OnProfileWillBeDestroyed(Profile* profile) override {
    registrar_.RemoveAll();
    weak_factory_.InvalidateWeakPtrs();
    profile_->RemoveObserver(this);
    profile_ = nullptr;
  }

  void Sync(const BuiltIn& builtin) {
    if (!profile_) {
      return;
    }
    extensions::ComponentLoader* loader =
        extensions::ComponentLoader::Get(profile_);
    if (!loader) {
      return;
    }
    if (!profile_->GetPrefs()->GetBoolean(builtin.pref)) {
      if (loader->Exists(builtin.id)) {
        loader->Remove(std::string(builtin.id));
      }
      return;
    }
    if (loader->Exists(builtin.id)) {
      return;
    }
    const base::FilePath dir = ExtensionsDir().Append(builtin.name);
    extensions::GetExtensionFileTaskRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&ReadManifest, dir),
        base::BindOnce(&Watcher::Add, weak_factory_.GetWeakPtr(), builtin,
                       dir));
  }

 private:
  void Add(const BuiltIn& builtin,
           const base::FilePath& dir,
           std::optional<base::DictValue> manifest) {
    if (!profile_) {
      return;
    }
    extensions::ComponentLoader* loader =
        extensions::ComponentLoader::Get(profile_);
    // The pref may have changed while the manifest was read.
    if (!manifest || !loader || loader->Exists(builtin.id) ||
        !profile_->GetPrefs()->GetBoolean(builtin.pref)) {
      return;
    }
    const std::string id = loader->Add(std::move(*manifest), dir);
    if (id != builtin.id) {
      LOG(ERROR) << "Perch: the built-in extension " << builtin.name
                 << " loaded as '" << id << "', expected " << builtin.id
                 << "; its manifest key doesn't match";
    }
  }

  raw_ptr<Profile> profile_;
  PrefChangeRegistrar registrar_;
  base::WeakPtrFactory<Watcher> weak_factory_{this};
};

}  // namespace

void AddPerchComponentExtensions(Profile* profile) {
  if (!profile || profile->IsOffTheRecord() || profile->IsSystemProfile()) {
    return;
  }
  if (!profile->GetUserData(kWatcherKey)) {
    profile->SetUserData(kWatcherKey, std::make_unique<Watcher>(profile));
  }
  auto* watcher = static_cast<Watcher*>(profile->GetUserData(kWatcherKey));
  for (const BuiltIn& builtin : kBuiltIns) {
    watcher->Sync(builtin);
  }
}

std::vector<BuiltInExtensionState> ListBuiltInExtensions(Profile* profile) {
  std::vector<BuiltInExtensionState> result;
  for (const BuiltIn& builtin : kBuiltIns) {
    result.push_back(
        {builtin.name, profile->GetPrefs()->GetBoolean(builtin.pref)});
  }
  return result;
}

bool SetBuiltInExtensionEnabled(Profile* profile,
                                std::string_view name,
                                bool enabled) {
  for (const BuiltIn& builtin : kBuiltIns) {
    if (name == builtin.name) {
      profile->GetPrefs()->SetBoolean(builtin.pref, enabled);
      return true;
    }
  }
  return false;
}

bool IsPerchComponentExtension(std::string_view id) {
  for (const BuiltIn& builtin : kBuiltIns) {
    if (id == builtin.id) {
      return true;
    }
  }
  return false;
}

}  // namespace perch
