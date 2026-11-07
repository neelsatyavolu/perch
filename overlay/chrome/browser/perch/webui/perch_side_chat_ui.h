// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_SIDE_CHAT_UI_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_SIDE_CHAT_UI_H_

#include <string_view>

#include "chrome/browser/ui/webui/top_chrome/top_chrome_webui_config.h"
#include "chrome/browser/ui/webui/top_chrome/untrusted_top_chrome_web_ui_controller.h"

namespace content {
class WebUI;
}

namespace perch {

inline constexpr char kSideChatHost[] = "perch-side-chat.top-chrome";
inline constexpr char kSideChatURL[] =
    "chrome-untrusted://perch-side-chat.top-chrome/";

class PerchSideChatUI;

class PerchSideChatUIConfig
    : public DefaultTopChromeWebUIConfig<PerchSideChatUI> {
 public:
  PerchSideChatUIConfig();
  ~PerchSideChatUIConfig() override;
};

// The side chat (ui/ sidebar.html). It shows model output and web text, so it
// runs on an untrusted origin with no bindings: it reaches perchd's app API
// over loopback with a per-launch token that config.js hands it, and never
// sees a privileged API.
class PerchSideChatUI : public UntrustedTopChromeWebUIController {
 public:
  explicit PerchSideChatUI(content::WebUI* web_ui);
  PerchSideChatUI(const PerchSideChatUI&) = delete;
  PerchSideChatUI& operator=(const PerchSideChatUI&) = delete;
  ~PerchSideChatUI() override;

  static constexpr std::string_view GetWebUIName() { return "PerchSideChat"; }

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_SIDE_CHAT_UI_H_
