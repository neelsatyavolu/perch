// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_UI_SOURCE_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_UI_SOURCE_H_

#include <string_view>

#include "base/files/file_path.h"

namespace content {
class WebUIDataSource;
}

namespace perch {

enum class PageKind {
  // The full-page chat, from ui/dist.
  kChat,
  // The side chat, from ui/dist; its config.js also defines window.perchHost.
  kSidePanel,
  // Settings, New Tab and the other ui-pages/ entries, from ui-pages/dist.
  kPages,
  // A trusted shell from ui/dist that frames a chat page; no network.
  kShell,
};

// Serves Perch's built pages (in the app bundle) on `source`, with
// `default_page` for the root and config.js telling the page where perchd is.
// The CSP lets the page reach perchd on loopback and nothing else.
void ServePerchPages(content::WebUIDataSource* source,
                     std::string_view default_page,
                     PageKind kind);

// Where ui-pages/dist is: --perch-pages-dir, else Resources/perch_pages.
base::FilePath PagesDir();

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_UI_SOURCE_H_
