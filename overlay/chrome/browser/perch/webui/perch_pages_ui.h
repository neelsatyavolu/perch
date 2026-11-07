// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_PAGES_UI_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_PAGES_UI_H_

#include <memory>
#include <string>
#include <string_view>

#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"

namespace content {
class WebUIConfigMap;
}

namespace perch {

// Perch's own pages, built from ui-pages/: Settings, New Tab, Memory,
// Routines, Import and Welcome, each on chrome://perch-<page> (perch://<page>).
// Each page gets chrome.send for the settings the browser owns
// (PerchPageHandler) and reaches perchd on loopback for everything else.
class PerchPagesUIConfig : public content::WebUIConfig {
 public:
  PerchPagesUIConfig(std::string_view host, std::string_view page);
  ~PerchPagesUIConfig() override;

  std::unique_ptr<content::WebUIController> CreateWebUIController(
      content::WebUI* web_ui,
      const GURL& url) override;

 private:
  const std::string page_;
};

class PerchPagesUI : public content::WebUIController {
 public:
  PerchPagesUI(content::WebUI* web_ui,
               std::string_view host,
               std::string_view page);
  PerchPagesUI(const PerchPagesUI&) = delete;
  PerchPagesUI& operator=(const PerchPagesUI&) = delete;
  ~PerchPagesUI() override;

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

// Adds a config for each page. Called from RegisterChromeWebUIConfigs().
void RegisterPerchPagesWebUIConfigs(content::WebUIConfigMap& map);

// Whether `host` is one of Perch's pages, which may reach perchd on loopback
// although they have WebUI bindings (their CSP allows only perchd).
bool IsPerchPageHost(std::string_view host);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_PAGES_UI_H_
