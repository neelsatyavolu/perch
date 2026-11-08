// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/artifact_scheme.h"

#include <utility>

#include "base/memory/weak_ptr.h"
#include "base/types/pass_key.h"
#include "chrome/browser/perch/agent/perchd_launcher.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/storage_partition.h"
#include "mojo/public/cpp/bindings/remote.h"
#include "net/base/net_errors.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/self_deleting_url_loader_factory.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/url_loader_completion_status.h"
#include "services/network/public/mojom/url_loader.mojom.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("perch_artifacts", R"(
      semantics {
        sender: "Perch artifacts"
        description:
          "Loads an artifact (a page the agent made) from Perch's local agent "
          "(perchd, on this Mac's loopback interface) for a perch-artifact:// "
          "address."
        trigger: "Opening an artifact."
        data: "The artifact's id and version. Never leaves this Mac."
        destination: LOCAL
        internal { contacts { email: "build@perch.invalid" } }
        user_data { type: NONE }
        last_reviewed: "2026-11-08"
      }
      policy {
        cookies_allowed: NO
        setting: "Start Perch with --perch-no-agent to turn the agent off."
        policy_exception_justification: "Local only."
      })");

// Ids, versions and file names: letters, digits, dots, dashes, underscores.
bool IsSafe(std::string_view value) {
  if (value.empty() || value.find("..") != std::string_view::npos) {
    return false;
  }
  for (char c : value) {
    if (!base::IsAsciiAlphaNumeric(c) && c != '-' && c != '_' && c != '.' &&
        c != '/') {
      return false;
    }
  }
  return true;
}

class ArtifactURLLoaderFactory : public network::SelfDeletingURLLoaderFactory {
 public:
  ArtifactURLLoaderFactory(
      content::BrowserContext* context,
      mojo::PendingReceiver<network::mojom::URLLoaderFactory> receiver,
      base::SelfDeletingPassKey key)
      : network::SelfDeletingURLLoaderFactory(std::move(receiver), key),
        context_(context->GetWeakPtr()) {}

 private:
  ~ArtifactURLLoaderFactory() override = default;

  void CreateLoaderAndStart(
      mojo::PendingReceiver<network::mojom::URLLoader> loader,
      int32_t request_id,
      uint32_t options,
      const network::ResourceRequest& request,
      mojo::PendingRemote<network::mojom::URLLoaderClient> client,
      const net::MutableNetworkTrafficAnnotationTag& traffic_annotation)
      override {
    const PerchdLauncher& launcher = PerchdLauncher::Get();
    const std::string host(request.url.host());
    const std::string path(request.url.path());
    if (!context_ || launcher.ApiOrigin().empty() ||
        request.method != "GET" || !IsSafe(host) ||
        (!path.empty() && path != "/" && !IsSafe(path.substr(1)))) {
      mojo::Remote<network::mojom::URLLoaderClient>(std::move(client))
          ->OnComplete(network::URLLoaderCompletionStatus(net::ERR_FAILED));
      return;
    }
    network::ResourceRequest forwarded;
    forwarded.url = GURL(launcher.ApiOrigin() + "/api/artifact-frames/" + host +
                         (path == "/" ? std::string() : path));
    forwarded.method = "GET";
    forwarded.credentials_mode = network::mojom::CredentialsMode::kOmit;
    forwarded.mode = network::mojom::RequestMode::kNoCors;
    forwarded.headers.SetHeader("Authorization",
                                "Bearer " + launcher.browser_token());
    context_->GetDefaultStoragePartition()
        ->GetURLLoaderFactoryForBrowserProcess()
        ->CreateLoaderAndStart(std::move(loader), request_id, options,
                               forwarded, std::move(client),
                               net::MutableNetworkTrafficAnnotationTag(
                                   kTrafficAnnotation));
  }

  base::WeakPtr<content::BrowserContext> context_;
};

}  // namespace

mojo::PendingRemote<network::mojom::URLLoaderFactory>
CreateArtifactURLLoaderFactory(content::BrowserContext* context) {
  mojo::PendingRemote<network::mojom::URLLoaderFactory> remote;
  if (!context || context->IsOffTheRecord()) {
    return remote;
  }
  base::MakeSelfDeleting<ArtifactURLLoaderFactory>(
      context, remote.InitWithNewPipeAndPassReceiver());
  return remote;
}

}  // namespace perch
