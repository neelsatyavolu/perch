// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_side_chat_ui.h"

#include "chrome/browser/perch/webui/perch_ui_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"

namespace perch {

PerchSideChatUIConfig::PerchSideChatUIConfig()
    : DefaultTopChromeWebUIConfig(content::kChromeUIUntrustedScheme,
                                  kSideChatHost) {}

PerchSideChatUIConfig::~PerchSideChatUIConfig() = default;

PerchSideChatUI::PerchSideChatUI(content::WebUI* web_ui)
    : UntrustedTopChromeWebUIController(web_ui) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), kSideChatURL);
  ServePerchPages(source, "sidebar.html", /*side_panel=*/true);
}

PerchSideChatUI::~PerchSideChatUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(PerchSideChatUI)

}  // namespace perch
