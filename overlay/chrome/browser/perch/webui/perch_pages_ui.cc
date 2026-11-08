// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_pages_ui.h"

#include <string>
#include <utility>

#include "chrome/browser/perch/command_bar/command_bar.h"
#include "chrome/browser/perch/webui/perch_page_handler.h"
#include "chrome/browser/perch/webui/perch_side_chat_ui.h"
#include "chrome/browser/perch/webui/perch_ui_source.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/browser/webui_config_map.h"
#include "content/public/common/url_constants.h"

namespace perch {

namespace {

// chrome:// host, page in ui-pages/dist.
constexpr std::pair<std::string_view, std::string_view> kPages[] = {
    {"perch-settings", "settings.html"}, {"perch-newtab", "newtab.html"},
    {"perch-memory", "memory.html"},     {"perch-routines", "routines.html"},
    {"perch-import", "import.html"},     {"perch-welcome", "welcome.html"},
};

}  // namespace

PerchPagesUIConfig::PerchPagesUIConfig(std::string_view host,
                                       std::string_view page)
    : content::WebUIConfig(content::kChromeUIScheme, host), page_(page) {}

PerchPagesUIConfig::~PerchPagesUIConfig() = default;

std::unique_ptr<content::WebUIController>
PerchPagesUIConfig::CreateWebUIController(content::WebUI* web_ui,
                                          const GURL& url) {
  return std::make_unique<PerchPagesUI>(web_ui, host(), page_);
}

PerchPagesUI::PerchPagesUI(content::WebUI* web_ui,
                           std::string_view host,
                           std::string_view page)
    : content::WebUIController(web_ui) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), std::string(host));
  ServePerchPages(source, page, PageKind::kPages);
  web_ui->AddMessageHandler(std::make_unique<PerchPageHandler>());
}

PerchPagesUI::~PerchPagesUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(PerchPagesUI)

void RegisterPerchPagesWebUIConfigs(content::WebUIConfigMap& map) {
  for (const auto& [host, page] : kPages) {
    map.AddWebUIConfig(std::make_unique<PerchPagesUIConfig>(host, page));
  }
  map.AddWebUIConfig(std::make_unique<PerchCommandBarUIConfig>());
  map.AddWebUIConfig(std::make_unique<PerchSideShellUIConfig>());
}

bool IsPerchPageHost(std::string_view host) {
  for (const auto& [page_host, page] : kPages) {
    if (host == page_host) {
      return true;
    }
  }
  return false;
}

}  // namespace perch
