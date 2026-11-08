// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/key_broker.h"

#include <unistd.h>

#include <utility>

#include "base/apple/bundle_locations.h"
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
#include "chrome/browser/profiles/profile_manager.h"

namespace perch {

namespace {

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

// One request to the helper: a frame in, a frame out, then it exits.
std::optional<base::DictValue> AskHelper(const base::DictValue& request) {
  const base::FilePath helper = HelperPath();
  if (!base::PathExists(helper)) {
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
    reply = ReadFrame(read_end.get());
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

// Runs off the UI thread: "get", and "create" when the helper has no key yet.
std::optional<KeyBroker::Entry> FetchKey(std::string profile_id) {
  std::optional<base::DictValue> reply = AskHelper(
      base::DictValue().Set("op", "get").Set("profile", profile_id));
  const std::string* error = reply ? reply->FindString("error") : nullptr;
  if (reply && error && *error == "missing") {
    reply = AskHelper(
        base::DictValue().Set("op", "create").Set("profile", profile_id));
  }
  const std::string* key = reply ? reply->FindString("key") : nullptr;
  std::optional<std::vector<uint8_t>> bytes =
      key ? base::Base64Decode(*key) : std::nullopt;
  if (!bytes || bytes->size() != 32) {
    if (reply) {
      LOG(ERROR) << "Perch: the key helper gave no key for " << profile_id;
    }
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
  if (keys_.contains(dir) ||
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
      base::BindOnce(&FetchKey, profile_dir.BaseName().value()),
      base::BindOnce(&KeyBroker::OnFetched, weak_factory_.GetWeakPtr(),
                     profile_dir));
}

void KeyBroker::OnFetched(base::FilePath profile_dir,
                          std::optional<Entry> entry) {
  std::erase(pending_, profile_dir);
  if (!entry) {
    return;
  }
  Send(profile_dir, *entry);
  // The recovery key goes to perchd once, when the key was made.
  entry->recovery.clear();
  keys_[profile_dir] = std::move(*entry);
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
