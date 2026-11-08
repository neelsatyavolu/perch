// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_chat_ui.h"

#include "chrome/browser/perch/webui/perch_shell_handler.h"
#include "chrome/browser/perch/webui/perch_ui_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/bindings_policy.h"
#include "content/public/common/url_constants.h"

namespace perch {

PerchChatUIConfig::PerchChatUIConfig()
    : DefaultWebUIConfig(content::kChromeUIScheme, kChatHost) {}

PerchChatFrameUIConfig::PerchChatFrameUIConfig()
    : DefaultWebUIConfig(content::kChromeUIUntrustedScheme, kChatHost) {}

PerchChatUI::PerchChatUI(content::WebUI* web_ui)
    : content::WebUIController(web_ui) {
  // The shell has bindings and no network; the chat frame has the network
  // and no bindings.
  web_ui->AddRequestableScheme(content::kChromeUIUntrustedScheme);
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), kChatHost);
  ServePerchPages(source, "shell-chat.html", PageKind::kShell);
  web_ui->AddMessageHandler(std::make_unique<PerchShellHandler>());
}

PerchChatFrameUI::PerchChatFrameUI(content::WebUI* web_ui)
    : ui::UntrustedWebUIController(web_ui) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), kChatFrameURL);
  ServePerchPages(source, "chat.html", PageKind::kChat);
  source->AddFrameAncestor(GURL(kChatURL));
}

PerchChatFrameUI::~PerchChatFrameUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(PerchChatFrameUI)

PerchChatUI::~PerchChatUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(PerchChatUI)

}  // namespace perch
