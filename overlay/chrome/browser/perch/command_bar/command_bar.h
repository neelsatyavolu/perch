// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_COMMAND_BAR_COMMAND_BAR_H_
#define CHROME_BROWSER_PERCH_COMMAND_BAR_COMMAND_BAR_H_

#include <string>
#include <string_view>

#include "base/functional/callback_forward.h"
#include "base/values.h"
#include "chrome/browser/ui/webui/top_chrome/top_chrome_web_ui_controller.h"
#include "chrome/browser/ui/webui/top_chrome/top_chrome_webui_config.h"

class BrowserWindowInterface;
class Profile;

namespace content {
class WebUI;
}

namespace views {
class Widget;
}

namespace perch {

inline constexpr char kCommandBarHost[] = "perch-command-bar.top-chrome";
inline constexpr char kCommandBarURL[] =
    "chrome://perch-command-bar.top-chrome/";

// Opens the command bar (⌘K) at the top centre of the window, or closes it.
void ToggleCommandBar(BrowserWindowInterface* browser);
// Drops the window's command bar when the window goes away.
void ForgetCommandBar(BrowserWindowInterface* browser);
// The open bar's widget, or null (the snapshot tool draws it).
views::Widget* GetCommandBarWidget(BrowserWindowInterface* browser);

// The bar's own commands: shows it once the page asked for its first
// results, and closes it after it ran something.
void ShowCommandBarNow(content::WebUI* web_ui);
void CloseCommandBarNow(content::WebUI* web_ui);

// Open tabs, bookmarks and history matching `text` (ui-pages api.ts
// CommandBarResult[]), at most 8 of each, tabs first.
void QueryCommandBar(Profile* profile,
                     const std::string& text,
                     base::OnceCallback<void(base::ListValue)> reply);

// Runs one result or command ({kind, url?, tabId?, id?}). False when the item
// names nothing Perch knows.
bool RunCommandBarItem(BrowserWindowInterface* browser,
                       const base::DictValue& item);

// Puts "[title](url)" for the active tab on the clipboard.
void CopyUrlAsMarkdown(BrowserWindowInterface* browser);

class PerchCommandBarUI;

class PerchCommandBarUIConfig
    : public DefaultTopChromeWebUIConfig<PerchCommandBarUI> {
 public:
  PerchCommandBarUIConfig();
  ~PerchCommandBarUIConfig() override;

  // The bubble takes the page's size.
  bool ShouldAutoResizeHost() override;
};

// chrome://perch-command-bar.top-chrome: ui-pages' command-bar.html in a
// bubble, talking to the browser over chrome.send like Perch's other pages.
class PerchCommandBarUI : public TopChromeWebUIController {
 public:
  explicit PerchCommandBarUI(content::WebUI* web_ui);
  PerchCommandBarUI(const PerchCommandBarUI&) = delete;
  PerchCommandBarUI& operator=(const PerchCommandBarUI&) = delete;
  ~PerchCommandBarUI() override;

  static constexpr std::string_view GetWebUIName() {
    return "PerchCommandBar";
  }

 private:
  WEB_UI_CONTROLLER_TYPE_DECL();
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_COMMAND_BAR_COMMAND_BAR_H_
