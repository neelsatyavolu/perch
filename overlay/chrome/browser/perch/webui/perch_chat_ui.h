// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_CHAT_UI_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_CHAT_UI_H_

#include "content/public/browser/web_ui_controller.h"
#include "content/public/browser/webui_config.h"
#include "ui/webui/untrusted_web_ui_controller.h"

namespace perch {

inline constexpr char kChatHost[] = "perch-chat";
inline constexpr char kChatURL[] = "chrome://perch-chat/";

inline constexpr char kChatFrameURL[] = "chrome-untrusted://perch-chat/";

class PerchChatUI;
class PerchChatFrameUI;

class PerchChatUIConfig : public content::DefaultWebUIConfig<PerchChatUI> {
 public:
  PerchChatUIConfig();
};

class PerchChatFrameUIConfig
    : public content::DefaultWebUIConfig<PerchChatFrameUI> {
 public:
  PerchChatFrameUIConfig();
};

// chrome-untrusted://perch-chat: the chat page itself (ui/ chat.html). It
// shows model output and web text, so it has no bindings and reaches perchd
// over loopback; only chrome://perch-chat may frame it.
class PerchChatFrameUI : public ui::UntrustedWebUIController {
 public:
  explicit PerchChatFrameUI(content::WebUI* web_ui);
  PerchChatFrameUI(const PerchChatFrameUI&) = delete;
  PerchChatFrameUI& operator=(const PerchChatFrameUI&) = delete;
  ~PerchChatFrameUI() override;

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

// The full-page chat (docs/design/webui-hosting.md): chat.html from ui/dist in
// a normal tab. It has no Mojo bindings and no message handlers; it talks only
// to perchd's app API on loopback.
// chrome://perch-chat: the trusted shell (ui/ shell-chat.html) that frames the
// chat page and relays its few host calls (PerchShellHandler).
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
