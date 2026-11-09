// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/key_broker.h"

#include <poll.h>

#include <unistd.h>

#include <utility>

#include <Security/Security.h>

#include "base/apple/bundle_locations.h"
#include "base/apple/foundation_util.h"
#include "base/apple/scoped_cftyperef.h"
#include "base/base64.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/posix/eintr_wrapper.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/perch/keys/backup.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "content/public/browser/page_navigator.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace perch {

namespace {

void ShowRestorePage(BrowserWindowInterface* browser) {
  browser->OpenURL(
        content::OpenURLParams(GURL("chrome://perch-welcome/#restore"),
                               content::Referrer(),
                               WindowOpenDisposition::kNewForegroundTab,
                               ui::PAGE_TRANSITION_AUTO_TOPLEVEL, false),
        {});
}

// Opens perch://welcome#restore in a window of the profile that needs it.
// False when the profile has no window yet.
bool OpenRestorePage(const base::FilePath& profile_dir) {
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    if (browser->GetProfile()->GetPath() == profile_dir) {
      ShowRestorePage(browser);
      return true;
    }
  }
  return false;
}

constexpr size_t kMaxFrame = 64 * 1024;

base::FilePath HelperPath() {
  return base::apple::FrameworkBundlePath()
      .Append("Helpers")
      .Append("Perch Keys.app")
      .Append("Contents")
      .Append("MacOS")
      .Append("PerchKeys");
}

bool WriteFrame(int fd, const std::string& body) {
  const uint32_t length = static_cast<uint32_t>(body.size());
  const uint8_t header[4] = {
      static_cast<uint8_t>(length), static_cast<uint8_t>(length >> 8),
      static_cast<uint8_t>(length >> 16), static_cast<uint8_t>(length >> 24)};
  return base::WriteFileDescriptor(fd, base::span(header)) &&
         base::WriteFileDescriptor(fd, body);
}

std::optional<std::string> ReadFrame(int fd) {
  uint8_t header[4];
  if (!base::ReadFromFD(fd, base::as_writable_chars(base::span(header)))) {
    return std::nullopt;
  }
  const size_t length = header[0] | (header[1] << 8) | (header[2] << 16) |
                        (static_cast<size_t>(header[3]) << 24);
  if (length > kMaxFrame) {
    return std::nullopt;
  }
  std::string body(length, '\0');
  if (length && !base::ReadFromFD(fd, base::span(body))) {
    return std::nullopt;
  }
  return body;
}

// Whether the code at `path` is signed by Perch's team (and, when given, is
// the program with `identifier`).
bool SignedByTeam(const base::FilePath& path, const char* identifier) {
  base::apple::ScopedCFTypeRef<CFURLRef> url =
      base::apple::FilePathToCFURL(path);
  base::apple::ScopedCFTypeRef<SecStaticCodeRef> code;
  if (SecStaticCodeCreateWithPath(url.get(), kSecCSDefaultFlags,
                                  code.InitializeInto()) != errSecSuccess) {
    return false;
  }
  std::string text =
      "anchor apple generic and certificate leaf[subject.OU] = \"VTQW687WBQ\"";
  if (identifier) {
    text += std::string(" and identifier \"") + identifier + "\"";
  }
  base::apple::ScopedCFTypeRef<CFStringRef> requirement_text(
      CFStringCreateWithCString(nullptr, text.c_str(), kCFStringEncodingUTF8));
  base::apple::ScopedCFTypeRef<SecRequirementRef> requirement;
  if (SecRequirementCreateWithString(requirement_text.get(), kSecCSDefaultFlags,
                                     requirement.InitializeInto()) !=
      errSecSuccess) {
    return false;
  }
  return SecStaticCodeCheckValidity(code.get(), kSecCSCheckAllArchitectures,
                                    requirement.get()) == errSecSuccess;
}

// A Perch signed by the team talks only to a key helper signed by the team.
// Development builds aren't signed, so they take the helper as it is.
bool HelperTrusted(const base::FilePath& helper_executable) {
  if (!SignedByTeam(base::apple::OuterBundlePath(), nullptr)) {
    return true;
  }
  const base::FilePath app = helper_executable.DirName().DirName().DirName();
  return SignedByTeam(app, "co.xanom.perch.keyhelper");
}

// One request to the helper: a frame in, a frame out, then it exits.
std::optional<base::DictValue> AskHelper(const base::DictValue& request) {
  const base::FilePath helper = HelperPath();
  if (!base::PathExists(helper)) {
    return std::nullopt;
  }
  if (!HelperTrusted(helper)) {
    LOG(ERROR) << "Perch: the key helper isn't signed by Perch; not using it";
    return std::nullopt;
  }
  int to_helper[2];
  int from_helper[2];
  if (pipe(to_helper) != 0) {
    return std::nullopt;
  }
  if (pipe(from_helper) != 0) {
    close(to_helper[0]);
    close(to_helper[1]);
    return std::nullopt;
  }
  base::ScopedFD child_in(to_helper[0]), write_end(to_helper[1]);
  base::ScopedFD read_end(from_helper[0]), child_out(from_helper[1]);
  base::LaunchOptions options;
  options.fds_to_remap.emplace_back(child_in.get(), STDIN_FILENO);
  options.fds_to_remap.emplace_back(child_out.get(), STDOUT_FILENO);
  base::Process process =
      base::LaunchProcess(base::CommandLine(helper), options);
  child_in.reset();
  child_out.reset();
  if (!process.IsValid()) {
    return std::nullopt;
  }
  std::optional<std::string> reply;
  if (WriteFrame(write_end.get(),
                 base::WriteJson(request).value_or("{}"))) {
    write_end.reset();
    // A helper that hangs without answering mustn't hold this thread.
    struct pollfd ready = {read_end.get(), POLLIN, 0};
    if (HANDLE_EINTR(poll(&ready, 1, /*timeout_ms=*/10000)) == 1) {
      reply = ReadFrame(read_end.get());
    }
  }
  int exit_code = 0;
  if (!process.WaitForExitWithTimeout(base::Seconds(10), &exit_code)) {
    process.Terminate(1, /*wait=*/false);
  }
  if (!reply) {
    return std::nullopt;
  }
  std::optional<base::Value> parsed =
      base::JSONReader::Read(*reply, base::JSON_PARSE_RFC);
  if (!parsed || !parsed->is_dict()) {
    return std::nullopt;
  }
  return std::move(*parsed).TakeDict();
}

std::optional<KeyBroker::Entry> EntryFrom(
    const std::optional<base::DictValue>& reply) {
  const std::string* key = reply ? reply->FindString("key") : nullptr;
  std::optional<std::vector<uint8_t>> bytes =
      key ? base::Base64Decode(*key) : std::nullopt;
  if (!bytes || bytes->size() != 32) {
    return std::nullopt;
  }
  KeyBroker::Entry entry;
  entry.key = std::move(*bytes);
  entry.is_protected = reply->FindBool("protected").value_or(false);
  if (const std::string* recovery = reply->FindString("recovery")) {
    entry.recovery = *recovery;
  }
  return entry;
}

// Runs off the UI thread: "get", and "create" when the helper has no key yet,
// unless the profile already has data made with a key (root.check): then a
// new key would lock that data away, so the person restores instead.
KeyBroker::Fetched FetchKey(base::FilePath profile_dir) {
  const std::string profile_id = profile_dir.BaseName().value();
  KeyBroker::Fetched fetched;
  fetched.helper_available = base::PathExists(HelperPath());
  std::optional<base::DictValue> reply = AskHelper(
      base::DictValue().Set("op", "get").Set("profile", profile_id));
  const std::string* error = reply ? reply->FindString("error") : nullptr;
  if (reply && error && *error == "missing") {
    // A new key would lock the profile's existing data away.
    if (HasKeyedData(profile_dir)) {
      fetched.needs_restore = true;
      return fetched;
    }
    reply = AskHelper(
        base::DictValue().Set("op", "create").Set("profile", profile_id));
  }
  fetched.entry = EntryFrom(reply);
  if (!fetched.entry) {
    if (reply) {
      LOG(ERROR) << "Perch: the key helper gave no key for " << profile_id;
    }
    return fetched;
  }
  // The data was made with another key: unlock it with the recovery key
  // rather than hand perchd a key that can't open it.
  if (CheckRootKey(profile_dir, fetched.entry->key) == false) {
    fetched.entry.reset();
    fetched.needs_restore = true;
    return fetched;
  }
  EnsureRootCheck(profile_dir, fetched.entry->key);
  return fetched;
}

base::expected<KeyBroker::Entry, std::string> ImportKey(
    base::FilePath profile_dir,
    std::vector<uint8_t> root_key) {
  std::optional<base::DictValue> reply =
      AskHelper(base::DictValue()
                    .Set("op", "import")
                    .Set("profile", profile_dir.BaseName().value())
                    .Set("key", base::Base64Encode(root_key)));
  if (!reply) {
    return base::unexpected(base::PathExists(HelperPath()) ? "failed"
                                                           : "unavailable");
  }
  std::optional<KeyBroker::Entry> entry = EntryFrom(reply);
  if (!entry) {
    return base::unexpected("failed");
  }
  return std::move(*entry);
}

}  // namespace

// static
KeyBroker& KeyBroker::Get() {
  static base::NoDestructor<KeyBroker> instance;
  return *instance;
}

KeyBroker::KeyBroker() = default;
KeyBroker::~KeyBroker() = default;

void KeyBroker::OnPerchdLaunched(LineSender sender) {
  sender_ = std::move(sender);
  if (!observation_.IsObserving() && g_browser_process->profile_manager()) {
    observation_.Observe(g_browser_process->profile_manager());
  }
  for (const auto& [dir, entry] : keys_) {
    Send(dir, entry);
  }
  if (ProfileManager* manager = g_browser_process->profile_manager()) {
    for (Profile* profile : manager->GetLoadedProfiles()) {
      EnsureProfile(profile);
    }
  }
}

void KeyBroker::OnProfileAdded(Profile* profile) {
  EnsureProfile(profile);
}

void KeyBroker::OnProfileMarkedForPermanentDeletion(Profile* profile) {
  const base::FilePath dir = profile->GetPath();
  keys_.erase(dir);
  if (sender_) {
    sender_.Run(base::WriteJson(base::DictValue()
                                    .Set("op", "profile-removed")
                                    .Set("id", dir.BaseName().value()))
                    .value_or("{}") +
                "\n");
  }
}

void KeyBroker::OnProfileManagerDestroying() {
  observation_.Reset();
}

void KeyBroker::EnsureProfile(Profile* profile) {
  if (!profile || profile->IsOffTheRecord() || profile->IsSystemProfile()) {
    return;
  }
  const base::FilePath dir = profile->GetPath();
  if (keys_.contains(dir) || needs_restore_.contains(dir) ||
      std::find(pending_.begin(), pending_.end(), dir) != pending_.end()) {
    return;
  }
  Fetch(dir);
}

std::optional<std::vector<uint8_t>> KeyBroker::RootKeyFor(
    const base::FilePath& profile_dir) const {
  auto it = keys_.find(profile_dir);
  if (it == keys_.end()) {
    return std::nullopt;
  }
  return it->second.key;
}

void KeyBroker::Fetch(const base::FilePath& profile_dir) {
  pending_.push_back(profile_dir);
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::WithBaseSyncPrimitives(),
       base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
      base::BindOnce(&FetchKey, profile_dir),
      base::BindOnce(&KeyBroker::OnFetched, weak_factory_.GetWeakPtr(),
                     profile_dir));
}

void KeyBroker::OnFetched(base::FilePath profile_dir, Fetched fetched) {
  std::erase(pending_, profile_dir);
  helper_available_ = fetched.helper_available;
  if (fetched.needs_restore) {
    needs_restore_.insert(profile_dir);
    if (!OpenRestorePage(profile_dir)) {
      restore_page_waiting_.insert(profile_dir);
    }
    return;
  }
  if (!fetched.entry) {
    return;
  }
  Entry entry = std::move(*fetched.entry);
  Send(profile_dir, entry);
  // The recovery key goes to perchd once, when the key was made.
  entry.recovery.clear();
  keys_[profile_dir] = std::move(entry);
}

void KeyBroker::OnWindowOpened(BrowserWindowInterface* browser) {
  const base::FilePath dir = browser->GetProfile()->GetPath();
  if (restore_page_waiting_.erase(dir)) {
    ShowRestorePage(browser);
  }
}

void KeyBroker::StartFresh(const base::FilePath& profile_dir) {
  needs_restore_.erase(profile_dir);
  restore_page_waiting_.erase(profile_dir);
  keys_.erase(profile_dir);
  if (std::find(pending_.begin(), pending_.end(), profile_dir) ==
      pending_.end()) {
    Fetch(profile_dir);
  }
}

bool KeyBroker::IsProtected(const base::FilePath& profile_dir) const {
  auto it = keys_.find(profile_dir);
  return it != keys_.end() && it->second.is_protected;
}

bool KeyBroker::NeedsRestore(const base::FilePath& profile_dir) const {
  return needs_restore_.contains(profile_dir);
}

void KeyBroker::ImportRootKey(
    const base::FilePath& profile_dir,
    std::vector<uint8_t> root_key,
    base::OnceCallback<void(std::optional<std::string>)> done) {
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::WithBaseSyncPrimitives(),
       base::TaskPriority::USER_BLOCKING},
      base::BindOnce(&ImportKey, profile_dir, std::move(root_key)),
      base::BindOnce(&KeyBroker::OnRestored, weak_factory_.GetWeakPtr(),
                     profile_dir, std::move(done)));
}

void KeyBroker::OnRestored(
    base::FilePath profile_dir,
    base::OnceCallback<void(std::optional<std::string>)> done,
    base::expected<Entry, std::string> result) {
  if (!result.has_value()) {
    std::move(done).Run(result.error());
    return;
  }
  needs_restore_.erase(profile_dir);
  Send(profile_dir, *result);
  keys_[profile_dir] = std::move(*result);
  std::move(done).Run(std::nullopt);
}

void KeyBroker::Send(const base::FilePath& profile_dir, const Entry& entry) {
  if (!sender_) {
    return;
  }
  base::DictValue line;
  line.Set("op", "profile");
  line.Set("id", profile_dir.BaseName().value());
  line.Set("dir", profile_dir.value());
  line.Set("key", base::Base64Encode(entry.key));
  line.Set("protected", entry.is_protected);
  if (!entry.recovery.empty()) {
    line.Set("recovery", entry.recovery);
  }
  sender_.Run(base::WriteJson(line).value_or("{}") + "\n");
}

}  // namespace perch
