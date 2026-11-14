// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/extensions/perch_extension_updates.h"

#include <memory>
#include <utility>
#include <vector>

#include "base/apple/bundle_locations.h"
#include "base/base64.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "base/values.h"
#include "base/version.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/perch/extensions/perch_component_extensions.h"
#include "chrome/browser/perch/privacy/allowed_connections.h"
#include "chrome/common/chrome_paths.h"
#include "extensions/browser/extension_file_task_runner.h"
#include "extensions/common/file_util.h"
#include "net/base/load_flags.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "third_party/boringssl/src/include/openssl/curve25519.h"
#include "third_party/zlib/google/zip.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr base::TimeDelta kFirstCheck = base::Minutes(2);
constexpr base::TimeDelta kInterval = base::Hours(24);
constexpr size_t kMaxReleaseJson = 1024 * 1024;
constexpr size_t kMaxSignature = 1024;
constexpr size_t kMaxZip = 64 * 1024 * 1024;

// What updates.json says about one extension.
struct Entry {
  std::string name;
  std::string repo;   // "owner/name" on GitHub.
  std::string asset;  // The zip's file name on the release.
  std::string root;   // The folder inside the zip that holds manifest.json.
  std::string from_version;  // Updates newer than this only.
  base::DictValue manifest;  // Keys Perch sets in the manifest.
  std::string key;
  bool incognito = false;
  bool disable_rulesets = false;
  std::string current_version;  // Filled in: the newest copy Perch has.

  Entry Clone() const {
    Entry copy;
    copy.name = name;
    copy.repo = repo;
    copy.asset = asset;
    copy.root = root;
    copy.from_version = from_version;
    copy.manifest = manifest.Clone();
    copy.key = key;
    copy.incognito = incognito;
    copy.disable_rulesets = disable_rulesets;
    copy.current_version = current_version;
    return copy;
  }
};

struct Config {
  std::vector<uint8_t> public_key;  // 32 bytes, Ed25519.
  std::vector<Entry> entries;
};

base::FilePath BundledDir() {
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

base::FilePath UpdatesDir() {
  base::FilePath user_data;
  base::PathService::Get(chrome::DIR_USER_DATA, &user_data);
  return user_data.Append(FILE_PATH_LITERAL("Perch Extensions"))
      .Append(FILE_PATH_LITERAL("updates"));
}

std::string VersionIn(const base::FilePath& dir) {
  std::string error;
  std::optional<base::DictValue> manifest =
      extensions::file_util::LoadManifest(dir, &error);
  const std::string* version =
      manifest ? manifest->FindString("version") : nullptr;
  return version ? *version : std::string();
}

bool Newer(const std::string& candidate, const std::string& than) {
  const base::Version a(candidate);
  const base::Version b(than);
  return a.IsValid() && (!b.IsValid() || a.CompareTo(b) > 0);
}

// Runs on the extension file task runner.
std::optional<Config> LoadConfig() {
  std::string text;
  if (!base::ReadFileToString(BundledDir().Append("updates.json"), &text)) {
    return std::nullopt;
  }
  std::optional<base::DictValue> json =
      base::JSONReader::ReadDict(text, base::JSON_PARSE_RFC);
  const std::string* key = json ? json->FindString("public_key") : nullptr;
  const base::ListValue* list = json ? json->FindList("extensions") : nullptr;
  std::optional<std::vector<uint8_t>> public_key =
      key ? base::Base64Decode(*key) : std::nullopt;
  if (!list || !public_key || public_key->size() != ED25519_PUBLIC_KEY_LEN) {
    LOG(ERROR) << "Perch: updates.json has no usable public key or list";
    return std::nullopt;
  }
  Config config;
  config.public_key = std::move(*public_key);
  for (const base::Value& item : *list) {
    const base::DictValue* d = item.GetIfDict();
    if (!d) {
      continue;
    }
    Entry e;
    for (auto [field, out] :
         {std::pair{"name", &e.name}, std::pair{"repo", &e.repo},
          std::pair{"asset", &e.asset}, std::pair{"root", &e.root},
          std::pair{"from_version", &e.from_version},
          std::pair{"key", &e.key}}) {
      if (const std::string* value = d->FindString(field)) {
        *out = *value;
      }
    }
    if (const base::DictValue* manifest = d->FindDict("manifest")) {
      e.manifest = manifest->Clone();
    }
    e.incognito = d->FindBool("incognito").value_or(false);
    e.disable_rulesets = d->FindBool("disable_rulesets").value_or(false);
    if (e.name.empty() || e.repo.empty() || e.asset.empty() || e.key.empty()) {
      continue;
    }
    const std::string bundled = VersionIn(BundledDir().AppendASCII(e.name));
    const std::string updated = VersionIn(UpdatesDir().AppendASCII(e.name));
    e.current_version = Newer(updated, bundled) ? updated : bundled;
    config.entries.push_back(std::move(e));
  }
  return config;
}

// The manifest as Perch runs it: its id key, its switches, no update_url,
// kept out of private windows unless allowed, its ad-rule lists off.
void PatchManifest(base::DictValue& manifest, const Entry& e) {
  manifest.Remove("update_url");
  manifest.Merge(e.manifest.Clone());
  manifest.Set("key", e.key);
  if (!e.incognito) {
    manifest.Set("incognito", "not_allowed");
  }
  if (e.disable_rulesets) {
    if (base::ListValue* rules = manifest.FindListByDottedPath(
            "declarative_net_request.rule_resources")) {
      for (base::Value& rule : *rules) {
        if (base::DictValue* d = rule.GetIfDict()) {
          d->Set("enabled", false);
        }
      }
    }
  }
}

// Runs on the extension file task runner: unpacks the verified zip, checks
// its version, patches its manifest and swaps it in as the waiting update.
bool Install(Entry e, const std::string& version, std::string zip) {
  base::ScopedTempDir temp;
  if (!temp.CreateUniqueTempDirUnderPath(UpdatesDir().DirName()) &&
      !(base::CreateDirectory(UpdatesDir().DirName()) &&
        temp.CreateUniqueTempDirUnderPath(UpdatesDir().DirName()))) {
    return false;
  }
  const base::FilePath zip_path = temp.GetPath().Append("release.zip");
  const base::FilePath unpacked = temp.GetPath().Append("unpacked");
  if (!base::WriteFile(zip_path, zip) || !zip::Unzip(zip_path, unpacked)) {
    LOG(ERROR) << "Perch: can't unpack the " << e.name << " update";
    return false;
  }
  const base::FilePath root =
      e.root.empty() ? unpacked : unpacked.AppendASCII(e.root);
  std::string error;
  std::optional<base::DictValue> manifest =
      extensions::file_util::LoadManifest(root, &error);
  const std::string* found = manifest ? manifest->FindString("version") : nullptr;
  if (!found || *found != version) {
    LOG(ERROR) << "Perch: the " << e.name << " " << version
               << " release has a manifest for another version";
    return false;
  }
  PatchManifest(*manifest, e);
  if (!base::WriteFile(root.Append(FILE_PATH_LITERAL("manifest.json")),
                       base::WriteJsonWithOptions(
                           *manifest, base::JSONWriter::OPTIONS_PRETTY_PRINT)
                           .value_or(""))) {
    return false;
  }
  const base::FilePath dest = UpdatesDir().AppendASCII(e.name);
  base::DeletePathRecursively(dest);
  if (!base::CreateDirectory(UpdatesDir()) || !base::Move(root, dest)) {
    LOG(ERROR) << "Perch: can't save the " << e.name << " update";
    return false;
  }
  LOG(WARNING) << "Perch: " << e.name << " " << version
               << " is ready and loads on the next launch";
  return true;
}

constexpr net::NetworkTrafficAnnotationTag kAnnotation =
    net::DefineNetworkTrafficAnnotation("perch_extension_updates", R"(
        semantics {
          sender: "Perch built-in extension updates"
          description:
            "Checks GitHub for a new signed release of an extension Perch "
            "ships built in (Caveatly, Backrow), and downloads it."
          trigger: "About once a day while Perch runs."
          data: "None beyond the request itself; no cookies are sent."
          destination: OTHER
          destination_other: "api.github.com and GitHub release downloads."
        }
        policy {
          cookies_allowed: NO
          setting:
            "Settings, Privacy, Connections Perch makes: Built-in extension "
            "updates."
          policy_exception_justification: "Perch-specific connection."
        })");

std::unique_ptr<network::SimpleURLLoader> Fetch(const GURL& url) {
  auto request = std::make_unique<network::ResourceRequest>();
  request->url = url;
  request->credentials_mode = network::mojom::CredentialsMode::kOmit;
  request->load_flags = net::LOAD_DISABLE_CACHE;
  request->headers.SetHeader("Accept", "application/vnd.github+json");
  request->headers.SetHeader("User-Agent", "Perch");
  return network::SimpleURLLoader::Create(std::move(request), kAnnotation);
}

// One extension's check: release, then signature, then zip, then install.
class Check {
 public:
  Check(Entry entry, std::vector<uint8_t> public_key)
      : entry_(std::move(entry)), public_key_(std::move(public_key)) {}

  void Start(base::OnceClosure done) {
    done_ = std::move(done);
    loader_ = Fetch(GURL("https://api.github.com/repos/" + entry_.repo +
                         "/releases/latest"));
    loader_->DownloadToString(
        g_browser_process->shared_url_loader_factory().get(),
        base::BindOnce(&Check::OnRelease, base::Unretained(this)),
        kMaxReleaseJson);
  }

 private:
  void OnRelease(std::optional<std::string> body) {
    std::optional<base::DictValue> release =
        body ? base::JSONReader::ReadDict(*body, base::JSON_PARSE_RFC)
             : std::nullopt;
    const std::string* tag = release ? release->FindString("tag_name") : nullptr;
    if (!tag) {
      return Finish();
    }
    version_ = std::string(base::TrimString(*tag, "vV", base::TRIM_LEADING));
    if (!Newer(version_, entry_.current_version) ||
        (!entry_.from_version.empty() &&
         Newer(entry_.from_version, version_))) {
      return Finish();
    }
    if (const base::ListValue* assets = release->FindList("assets")) {
      for (const base::Value& asset : *assets) {
        const base::DictValue* a = asset.GetIfDict();
        const std::string* name = a ? a->FindString("name") : nullptr;
        const std::string* url =
            a ? a->FindString("browser_download_url") : nullptr;
        if (name && url && *name == entry_.asset) {
          zip_url_ = GURL(*url);
        } else if (name && url && *name == entry_.asset + ".sig") {
          sig_url_ = GURL(*url);
        }
      }
    }
    if (!zip_url_.SchemeIs("https") || !sig_url_.SchemeIs("https")) {
      LOG(WARNING) << "Perch: " << entry_.name << " " << version_
                   << " has no signed release zip; keeping the current one";
      return Finish();
    }
    loader_ = Fetch(sig_url_);
    loader_->SetRetryOptions(1, network::SimpleURLLoader::RETRY_ON_5XX);
    loader_->DownloadToString(
        g_browser_process->shared_url_loader_factory().get(),
        base::BindOnce(&Check::OnSignature, base::Unretained(this)),
        kMaxSignature);
  }

  void OnSignature(std::optional<std::string> body) {
    std::optional<std::vector<uint8_t>> signature =
        body ? base::Base64Decode(base::TrimWhitespaceASCII(*body, base::TRIM_ALL))
             : std::nullopt;
    if (!signature || signature->size() != ED25519_SIGNATURE_LEN) {
      return Finish();
    }
    signature_ = std::move(*signature);
    loader_ = Fetch(zip_url_);
    loader_->DownloadToString(
        g_browser_process->shared_url_loader_factory().get(),
        base::BindOnce(&Check::OnZip, base::Unretained(this)), kMaxZip);
  }

  void OnZip(std::optional<std::string> zip) {
    if (!zip ||
        !ED25519_verify(reinterpret_cast<const uint8_t*>(zip->data()),
                        zip->size(), signature_.data(), public_key_.data())) {
      LOG(ERROR) << "Perch: the " << entry_.name << " " << version_
                 << " release isn't signed with Perch's key; ignoring it";
      return Finish();
    }
    extensions::GetExtensionFileTaskRunner()->PostTaskAndReply(
        FROM_HERE,
        base::BindOnce(base::IgnoreResult(&Install), entry_.Clone(), version_,
                       std::move(*zip)),
        base::BindOnce(&Check::Finish, base::Unretained(this)));
  }

  void Finish() { std::move(done_).Run(); }

  Entry entry_;
  std::vector<uint8_t> public_key_;
  std::string version_;
  GURL zip_url_;
  GURL sig_url_;
  std::vector<uint8_t> signature_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::OnceClosure done_;
};

class Updater {
 public:
  void Start() {
    if (started_) {
      return;
    }
    started_ = true;
    timer_.Start(FROM_HERE,
                 FastTimersForNetaudit() ? base::Seconds(5) : kFirstCheck,
                 base::BindRepeating(&Updater::CheckAll, base::Unretained(this)));
  }

 private:
  void CheckAll() {
    if (timer_.GetCurrentDelay() != kInterval) {
      timer_.Start(FROM_HERE, kInterval,
                   base::BindRepeating(&Updater::CheckAll,
                                       base::Unretained(this)));
    }
    if (!checks_.empty() ||
        !IsConnectionAllowed(Connection::kBuiltInExtensionUpdates)) {
      return;
    }
    extensions::GetExtensionFileTaskRunner()->PostTaskAndReplyWithResult(
        FROM_HERE, base::BindOnce(&LoadConfig),
        base::BindOnce(&Updater::OnConfig, base::Unretained(this)));
  }

  void OnConfig(std::optional<Config> config) {
    if (!config) {
      return;
    }
    for (Entry& entry : config->entries) {
      checks_.push_back(
          std::make_unique<Check>(std::move(entry), config->public_key));
    }
    pending_ = checks_.size();
    for (auto& check : checks_) {
      check->Start(base::BindOnce(&Updater::OnCheckDone, base::Unretained(this)));
    }
  }

  void OnCheckDone() {
    if (--pending_ == 0) {
      checks_.clear();
    }
  }

  bool started_ = false;
  base::RepeatingTimer timer_;
  std::vector<std::unique_ptr<Check>> checks_;
  size_t pending_ = 0;
};

}  // namespace

void StartExtensionUpdates() {
  static base::NoDestructor<Updater> updater;
  updater->Start();
}

std::optional<base::FilePath> NewerUpdateFor(
    std::string_view name,
    const std::string& bundled_version) {
  const base::FilePath dir = UpdatesDir().AppendASCII(name);
  const std::string version = VersionIn(dir);
  if (version.empty() || !Newer(version, bundled_version)) {
    return std::nullopt;
  }
  return dir;
}

}  // namespace perch
