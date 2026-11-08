// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/extensions/perch_component_extensions.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/apple/bundle_locations.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/path_service.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/weak_ptr.h"
#include "base/supports_user_data.h"
#include "base/values.h"
#include "chrome/browser/extensions/component_loader.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_observer.h"
#include "chrome/common/chrome_paths.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "extensions/browser/api/declarative_net_request/install_index_helper.h"
#include "extensions/browser/api/declarative_net_request/prefs_helper.h"
#include "extensions/browser/ruleset_parse_result.h"
#include "extensions/common/extension.h"
#include "extensions/common/mojom/manifest.mojom-shared.h"
#include "extensions/browser/extension_file_task_runner.h"
#include "extensions/browser/extension_prefs.h"
#include "extensions/common/api/declarative_net_request/constants.h"
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

// Where a built-in extension runs from: a copy in the user data folder,
// because Chromium writes the ad blocker's indexed rules into the extension's
// own folder, and the app bundle must stay as it was signed.
base::FilePath RunDir(std::string_view name) {
  base::FilePath user_data;
  base::PathService::Get(chrome::DIR_USER_DATA, &user_data);
  return user_data.Append(FILE_PATH_LITERAL("Perch Extensions"))
      .AppendASCII(name);
}

std::string VersionOf(const base::FilePath& dir) {
  std::string error;
  std::optional<base::DictValue> manifest =
      extensions::file_util::LoadManifest(dir, &error);
  const std::string* version = manifest ? manifest->FindString("version") : nullptr;
  return version ? *version : std::string();
}

struct Prepared {
  base::FilePath dir;
  base::DictValue manifest;
  // Ruleset id → checksum of the copy's indexed ad-rule lists.
  std::vector<std::pair<int, int>> checksums;
};

// Indexes the extension's static ad-rule lists into its copy, as an install
// would, and returns their checksums.
std::vector<std::pair<int, int>> IndexRulesets(const base::FilePath& dir,
                                               const base::DictValue& manifest) {
  std::vector<std::pair<int, int>> checksums;
  if (!manifest.FindByDottedPath("declarative_net_request")) {
    return checksums;
  }
  std::u16string error;
  scoped_refptr<const extensions::Extension> extension =
      extensions::Extension::Create(
          dir, extensions::mojom::ManifestLocation::kComponent, manifest,
          extensions::Extension::NO_FLAGS, &error);
  if (!extension) {
    LOG(ERROR) << "Perch: can't read the built-in extension in " << dir
               << ": " << base::UTF16ToUTF8(error);
    return checksums;
  }
  extensions::RulesetParseResult result = extensions::declarative_net_request::
      InstallIndexHelper::IndexAndPersistRulesOnInstall(*extension);
  if (result.error) {
    LOG(ERROR) << "Perch: can't index the ad-rule lists in " << dir << ": "
               << *result.error;
    return checksums;
  }
  for (const auto [key, value] : result.ruleset_install_prefs) {
    int id = 0;
    const std::optional<int> checksum =
        value.is_dict() ? value.GetDict().FindInt("checksum") : std::nullopt;
    if (base::StringToInt(key, &id) && checksum) {
      checksums.emplace_back(id, *checksum);
    }
  }
  return checksums;
}

// Runs on the extension file task runner: refreshes the copy when the bundled
// extension changed (a Perch update), then reads its manifest.
std::optional<Prepared> Prepare(const base::FilePath& bundled,
                                const base::FilePath& run_dir) {
  const std::string version = VersionOf(bundled);
  if (version.empty()) {
    LOG(ERROR) << "Perch: no built-in extension in " << bundled;
    return std::nullopt;
  }
  // Any change to the bundled manifest (a new version, or a development
  // build) replaces the copy. Both folders carry the extension's name.
  std::string bundled_manifest, run_manifest;
  base::ReadFileToString(bundled.Append(FILE_PATH_LITERAL("manifest.json")),
                         &bundled_manifest);
  base::ReadFileToString(run_dir.Append(FILE_PATH_LITERAL("manifest.json")),
                         &run_manifest);
  const bool refresh = bundled_manifest != run_manifest;
  if (refresh) {
    base::DeletePathRecursively(run_dir);
    if (!base::CreateDirectory(run_dir.DirName()) ||
        !base::CopyDirectory(bundled, run_dir.DirName(), /*recursive=*/true)) {
      LOG(ERROR) << "Perch: can't copy the built-in extension to " << run_dir;
      return std::nullopt;
    }
  }
  std::string error;
  std::optional<base::DictValue> manifest =
      extensions::file_util::LoadManifest(run_dir, &error);
  if (!manifest) {
    LOG(ERROR) << "Perch: can't load the built-in extension in " << run_dir
               << ": " << error;
    return std::nullopt;
  }
  // Every profile records the checksums, so they are kept beside the copy.
  const base::FilePath checksum_file =
      run_dir.AddExtension(FILE_PATH_LITERAL("checksums"));
  std::vector<std::pair<int, int>> checksums;
  if (refresh) {
    checksums = IndexRulesets(run_dir, *manifest);
    base::DictValue saved;
    for (const auto& [ruleset, checksum] : checksums) {
      saved.Set(base::NumberToString(ruleset), checksum);
    }
    base::WriteFile(checksum_file, base::WriteJson(saved).value_or("{}"));
  } else {
    std::string text;
    base::ReadFileToString(checksum_file, &text);
    std::optional<base::DictValue> saved =
        base::JSONReader::ReadDict(text, base::JSON_PARSE_RFC);
    if (!saved) {
      saved.emplace();
    }
    for (const auto [key, value] : *saved) {
      int ruleset = 0;
      if (base::StringToInt(key, &ruleset) && value.is_int()) {
        checksums.emplace_back(ruleset, value.GetInt());
      }
    }
  }
  return Prepared{run_dir, std::move(*manifest), std::move(checksums)};
}

// Chromium records each static ad-rule list's checksum when it installs an
// extension, and a built-in one is never installed: record the checksums of
// the lists just indexed, so they load.
void RecordRulesetChecksums(Profile* profile,
                            const std::string& id,
                            const std::vector<std::pair<int, int>>& checksums) {
  extensions::declarative_net_request::PrefsHelper helper(
      *extensions::ExtensionPrefs::Get(profile));
  for (const auto& [ruleset, checksum] : checksums) {
    helper.SetStaticRulesetChecksum(
        id, extensions::declarative_net_request::RulesetID(ruleset), checksum);
  }
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
    extensions::GetExtensionFileTaskRunner()->PostTaskAndReplyWithResult(
        FROM_HERE,
        base::BindOnce(&Prepare, ExtensionsDir().Append(builtin.name),
                       RunDir(builtin.name)),
        base::BindOnce(&Watcher::Add, weak_factory_.GetWeakPtr(), builtin));
  }

 private:
  void Add(const BuiltIn& builtin, std::optional<Prepared> prepared) {
    if (!profile_) {
      return;
    }
    extensions::ComponentLoader* loader =
        extensions::ComponentLoader::Get(profile_);
    // The pref may have changed while the files were prepared.
    if (!prepared || !loader || loader->Exists(builtin.id) ||
        !profile_->GetPrefs()->GetBoolean(builtin.pref)) {
      return;
    }
    RecordRulesetChecksums(profile_, builtin.id, prepared->checksums);
    const std::string id =
        loader->Add(std::move(prepared->manifest), prepared->dir);
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
