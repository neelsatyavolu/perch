// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/keys/perch_keys_host.h"

#include <optional>
#include <vector>

#include "base/base64.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/memory/raw_ptr.h"
#include "base/task/single_thread_task_runner.h"
#include "base/values.h"
#include "chrome/browser/perch/extensions/perch_component_extensions.h"
#include "chrome/browser/perch/keys/key_broker.h"
#include "chrome/browser/profiles/profile.h"
#include "content/public/browser/browser_context.h"
#include "crypto/hash.h"
#include "crypto/kdf.h"
#include "extensions/browser/api/messaging/native_message_host.h"

namespace perch {

namespace {

constexpr char kAuthenticatorInfo[] = "perch/authenticator/v1";

class PerchKeysHost : public extensions::NativeMessageHost {
 public:
  explicit PerchKeysHost(base::FilePath profile_dir)
      : profile_dir_(std::move(profile_dir)) {}

  void Start(Client* client) override { client_ = client; }

  void OnMessage(const std::string& message) override {
    if (!client_) {
      return;
    }
    std::optional<base::Value> parsed =
        base::JSONReader::Read(message, base::JSON_PARSE_RFC);
    const std::string* op =
        parsed && parsed->is_dict() ? parsed->GetDict().FindString("op")
                                    : nullptr;
    base::DictValue reply;
    std::optional<std::vector<uint8_t>> root =
        KeyBroker::Get().RootKeyFor(profile_dir_);
    if (!op || *op != "authenticator") {
      reply.Set("error", "unknown-op");
    } else if (!root) {
      // No Secure Enclave helper in this build: the extension keeps its own.
      reply.Set("error", "unavailable");
    } else {
      const std::array<uint8_t, 32> key = crypto::kdf::Hkdf<32>(
          crypto::hash::HashKind::kSha256, *root, {},
          base::as_byte_span(std::string_view(kAuthenticatorInfo)));
      reply.Set("key", base::Base64Encode(key));
    }
    client_->PostMessageFromNativeHost(base::WriteJson(reply).value_or("{}"));
  }

  scoped_refptr<base::SingleThreadTaskRunner> task_runner() const override {
    return base::SingleThreadTaskRunner::GetCurrentDefault();
  }

 private:
  const base::FilePath profile_dir_;
  raw_ptr<Client> client_ = nullptr;
};

}  // namespace

std::unique_ptr<extensions::NativeMessageHost> CreatePerchKeysHost(
    content::BrowserContext* context,
    const std::string& extension_id,
    std::string* error) {
  if (!IsPerchComponentExtension(extension_id) ||
      extension_id != kPerchExtensionId) {
    *error = "Access to the specified native messaging host is forbidden.";
    return nullptr;
  }
  if (!context || context->IsOffTheRecord()) {
    *error = "Perch's keys aren't available in a private window.";
    return nullptr;
  }
  return std::make_unique<PerchKeysHost>(context->GetPath());
}

}  // namespace perch
