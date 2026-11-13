// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_PAGE_HANDLER_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_PAGE_HANDLER_H_

#include <memory>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "components/prefs/pref_change_registrar.h"
#include "chrome/browser/perch/webui/perch_autocomplete.h"
#include "content/public/browser/web_ui_message_handler.h"

class GURL;
class Profile;

namespace perch {

// The browser's half of the pages API (ui-pages/src/api.ts). A page sends
// "perch.call" with [callbackId, method, args]; the reply resolves or rejects
// that callback. Methods perchd owns never come here (ui-pages/src/api/host.ts
// sends them to perchd), and an unknown method rejects with
// {code: "unavailable"}. Appearance changes reach every open page as a
// "perch-event" listener call.
class PerchPageHandler : public content::WebUIMessageHandler {
 public:
  PerchPageHandler();
  PerchPageHandler(const PerchPageHandler&) = delete;
  PerchPageHandler& operator=(const PerchPageHandler&) = delete;
  ~PerchPageHandler() override;

  // content::WebUIMessageHandler:
  void RegisterMessages() override;
  void OnJavascriptAllowed() override;
  void OnJavascriptDisallowed() override;

  // Answer a page's call (used by the restore steps, which run as callbacks).
  void Resolve(base::Value callback_id, base::Value result);
  void Reject(base::Value callback_id, std::string code, std::string message);

 private:
  void HandleCall(const base::ListValue& args);
  void Dispatch(const std::string& method,
                const base::ListValue& args,
                base::Value callback_id);
  // Shows the profile's recovery key after Touch ID (Settings › Sync).
  void RevealRecoveryKey(base::Value callback_id);
  // Settings › Privacy › Backup and restore, and perch://welcome#restore.
  void ExportBackup(base::Value callback_id);
  // Whether this is Settings or the welcome page, the only pages that may
  // reveal, export or restore keys.
  bool IsKeyPage();
  void RestoreFromRecoveryKey(base::Value callback_id,
                              const base::Value* params);
  void OnAppearanceChanged();
  // Opens `url` in this page's tab; `typed` counts it as typed in the
  // address bar, for history and its suggestions.
  void Navigate(const GURL& url, bool typed = false);

  Profile* profile();

  PrefChangeRegistrar appearance_registrar_;
  // The new tab page's Search box suggestions, made on first use.
  std::unique_ptr<PerchAutocomplete> autocomplete_;
  // Whether the welcome page has been let play its opening sound.
  bool sound_allowed_ = false;
  base::WeakPtrFactory<PerchPageHandler> weak_factory_{this};
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_PAGE_HANDLER_H_
