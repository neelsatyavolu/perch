// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_chat_ui.h"

#include "chrome/browser/perch/webui/perch_ui_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"

namespace perch {

PerchChatUIConfig::PerchChatUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kChatHost) {}

PerchChatUI::PerchChatUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), kChatHost);
  ServePerchPages(source, "chat.html", /*side_panel=*/false);
}

PerchChatUI::~PerchChatUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(PerchChatUI)

}  // namespace perch
