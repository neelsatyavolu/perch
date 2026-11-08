// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_WEBUI_PERCH_SHELL_HANDLER_H_
#define CHROME_BROWSER_PERCH_WEBUI_PERCH_SHELL_HANDLER_H_

#include <memory>
#include <string>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "base/values.h"
#include "content/public/browser/web_ui_message_handler.h"
#include "ui/shell_dialogs/select_file_dialog.h"

namespace network {
class SimpleURLLoader;
}

namespace perch {

// The trusted shell around a chat page (ui/ shell-chat.html, plan 3b task 8)
// relays a fixed list of calls from the untrusted chat frame:
//   chrome.send("perchHost", [id, method, args])
// answered with cr.webUIResponse(id, ok, result | {message}).
//   close          closes the chat's tab
//   openTab [url]  opens an http(s) or perch-artifact address in a new tab
//   chooseFiles    shows the open panel; perchd keeps the paths and the page
//                  gets [{id, name, size}] only
//   startDictation, stopDictation: not available yet.
class PerchShellHandler : public content::WebUIMessageHandler,
                          public ui::SelectFileDialog::Listener {
 public:
  PerchShellHandler();
  PerchShellHandler(const PerchShellHandler&) = delete;
  PerchShellHandler& operator=(const PerchShellHandler&) = delete;
  ~PerchShellHandler() override;

  // content::WebUIMessageHandler:
  void RegisterMessages() override;

  // ui::SelectFileDialog::Listener:
  void FileSelected(const ui::SelectedFileInfo& file, int index) override;
  void MultiFilesSelected(const std::vector<ui::SelectedFileInfo>& files) override;
  void FileSelectionCanceled() override;

 private:
  void HandleHost(const base::ListValue& args);
  void Reply(const std::string& id, bool ok, base::Value result);
  void ChooseFiles(const std::string& id);
  void SendPaths(std::vector<base::FilePath> paths);
  void OnFilesStored(std::unique_ptr<network::SimpleURLLoader> loader,
                     std::optional<std::string> body);

  scoped_refptr<ui::SelectFileDialog> dialog_;
  std::string pending_files_id_;
  base::WeakPtrFactory<PerchShellHandler> weak_factory_{this};
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_WEBUI_PERCH_SHELL_HANDLER_H_
