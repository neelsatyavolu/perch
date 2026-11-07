// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_CHAT_UI_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_CHAT_UI_H_

#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"

namespace perch {

inline constexpr char kChatHost[] = "perch-chat";
inline constexpr char kChatURL[] = "chrome://perch-chat/";

class PerchChatUI;

class PerchChatUIConfig : public content::DefaultWebUIConfig<PerchChatUI> {
 public:
  PerchChatUIConfig();
};

// The full-page chat (docs/design/webui-hosting.md): chat.html from ui/dist in
// a normal tab. It has no Mojo bindings and no message handlers; it talks only
// to perchd's app API on loopback.
class PerchChatUI : public content::WebUIController {
 public:
  explicit PerchChatUI(content::WebUI* web_ui);
  PerchChatUI(const PerchChatUI&) = delete;
  PerchChatUI& operator=(const PerchChatUI&) = delete;
  ~PerchChatUI() override;

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_CHAT_UI_H_
