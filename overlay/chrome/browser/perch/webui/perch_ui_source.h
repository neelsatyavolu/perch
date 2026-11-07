// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_UI_SOURCE_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_UI_SOURCE_H_

#include <string_view>

namespace content {
class WebUIDataSource;
}

namespace perch {

// Serves Perch's built pages (ui/dist, in the app bundle) on `source`, with
// `default_page` for the root and config.js telling the page where perchd is.
// The CSP lets the page reach perchd on loopback and nothing else. The side
// panel's config.js also defines window.perchHost.
void ServePerchPages(content::WebUIDataSource* source,
                     std::string_view default_page,
                     bool side_panel);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_UI_SOURCE_H_
