// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_ARTIFACT_SCHEME_H_
#define CHROME_BROWSER_PERCH_AGENT_ARTIFACT_SCHEME_H_

#include "mojo/public/cpp/bindings/pending_remote.h"
#include "services/network/public/mojom/url_loader_factory.mojom.h"

namespace content {
class BrowserContext;
}

namespace perch {

inline constexpr char kArtifactScheme[] = "perch-artifact";

// perch-artifact://<id>/<version>[/path] (plan 3b task 12): each artifact is
// its own origin, and its address carries no capability. The loader forwards
// the request to perchd's GET /api/artifact-frames/<id>/<version>[/path]
// with the browser's token; perchd's own headers (its CSP, nosniff) come back
// unchanged. Private profiles get no factory.
mojo::PendingRemote<network::mojom::URLLoaderFactory>
CreateArtifactURLLoaderFactory(content::BrowserContext* context);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_ARTIFACT_SCHEME_H_
