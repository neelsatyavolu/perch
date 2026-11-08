// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_shell_handler.h"

#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "chrome/browser/perch/agent/perchd_launcher.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/side_panel/side_panel_ui.h"
#include "chrome/browser/ui/webui/webui_embedding_context.h"
#include "chrome/browser/ui/select_file_policy/chrome_select_file_policy.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "ui/base/window_open_disposition.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr size_t kMaxFiles = 20;

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("perch_chat_files", R"(
      semantics {
        sender: "Perch chat"
        description:
          "Tells Perch's local agent (perchd, on this Mac's loopback "
          "interface) which files the person attached to a chat, so the page "
          "only ever holds opaque ids."
        trigger: "Choosing files in the chat's attach panel."
        data: "File paths. Never leaves this Mac."
        destination: LOCAL
        internal { contacts { email: "build@perch.invalid" } }
        user_data { type: NONE }
        last_reviewed: "2026-11-08"
      }
      policy {
        cookies_allowed: NO
        setting: "Start Perch with --perch-no-agent to turn the agent off."
        policy_exception_justification: "Local only."
      })");

bool IsOpenable(const GURL& url) {
  return url.is_valid() &&
         (url.SchemeIsHTTPOrHTTPS() || url.SchemeIs("perch-artifact"));
}

}  // namespace

PerchShellHandler::PerchShellHandler() = default;

PerchShellHandler::~PerchShellHandler() {
  if (dialog_) {
    dialog_->ListenerDestroyed();
  }
}

void PerchShellHandler::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "perchHost", base::BindRepeating(&PerchShellHandler::HandleHost,
                                       base::Unretained(this)));
}

void PerchShellHandler::Reply(const std::string& id,
                              bool ok,
                              base::Value result) {
  AllowJavascript();
  if (ok) {
    ResolveJavascriptCallback(base::Value(id), result);
  } else {
    RejectJavascriptCallback(base::Value(id), result);
  }
}

void PerchShellHandler::HandleHost(const base::ListValue& args) {
  if (args.size() < 2 || !args[0].is_string() || !args[1].is_string()) {
    return;
  }
  const std::string id = args[0].GetString();
  const std::string& method = args[1].GetString();
  const base::ListValue* call_args =
      args.size() > 2 ? args[2].GetIfList() : nullptr;
  content::WebContents* contents = web_ui()->GetWebContents();
  tabs::TabInterface* tab = tabs::TabInterface::MaybeGetFromContents(contents);
  BrowserWindowInterface* browser =
      tab ? tab->GetBrowserWindowInterface()
          : webui::GetBrowserWindowInterface(contents);

  if (method == "close") {
    Reply(id, true, base::Value());
    // The side chat closes its panel; the full chat closes its tab.
    if (!tab && browser) {
      if (SidePanelUI* panel = SidePanelUI::From(browser)) {
        panel->Close();
      }
      return;
    }
    if (browser) {
      TabStripModel* model = browser->GetTabStripModel();
      const int index = model->GetIndexOfWebContents(contents);
      if (index != TabStripModel::kNoTab) {
        model->CloseWebContentsAt(index, TabCloseTypes::CLOSE_USER_GESTURE);
      }
    }
    return;
  }
  if (method == "openTab") {
    const GURL url(call_args && !call_args->empty() &&
                           (*call_args)[0].is_string()
                       ? (*call_args)[0].GetString()
                       : std::string());
    if (!browser || !IsOpenable(url)) {
      Reply(id, false,
            base::Value(base::DictValue().Set("message", "That can't open")));
      return;
    }
    browser->OpenURL(
        content::OpenURLParams(url, content::Referrer(),
                               WindowOpenDisposition::kNewForegroundTab,
                               ui::PAGE_TRANSITION_LINK, false),
        {});
    Reply(id, true, base::Value());
    return;
  }
  if (method == "chooseFiles") {
    ChooseFiles(id);
    return;
  }
  Reply(id, false,
        base::Value(base::DictValue().Set(
            "message", method == "startDictation" || method == "stopDictation"
                           ? "Dictation isn't available in this build yet"
                           : "Unknown call")));
}

void PerchShellHandler::ChooseFiles(const std::string& id) {
  if (!pending_files_id_.empty()) {
    Reply(id, false,
          base::Value(base::DictValue().Set("message",
                                            "The open panel is already up")));
    return;
  }
  pending_files_id_ = id;
  content::WebContents* contents = web_ui()->GetWebContents();
  dialog_ = ui::SelectFileDialog::Create(
      this, std::make_unique<ChromeSelectFilePolicy>(contents));
  dialog_->SelectFile(ui::SelectFileDialog::SELECT_OPEN_MULTI_FILE,
                      u"Attach files", base::FilePath(), nullptr, 0,
                      base::FilePath::StringType(),
                      contents->GetTopLevelNativeWindow());
}

void PerchShellHandler::FileSelected(const ui::SelectedFileInfo& file,
                                     int index) {
  SendPaths({file.path()});
}

void PerchShellHandler::MultiFilesSelected(
    const std::vector<ui::SelectedFileInfo>& files) {
  std::vector<base::FilePath> paths;
  for (const ui::SelectedFileInfo& file : files) {
    if (paths.size() < kMaxFiles) {
      paths.push_back(file.path());
    }
  }
  SendPaths(std::move(paths));
}

void PerchShellHandler::FileSelectionCanceled() {
  const std::string id = std::exchange(pending_files_id_, std::string());
  if (!id.empty()) {
    Reply(id, true, base::Value(base::ListValue()));
  }
}

void PerchShellHandler::SendPaths(std::vector<base::FilePath> paths) {
  const PerchdLauncher& launcher = PerchdLauncher::Get();
  if (launcher.ApiOrigin().empty() || paths.empty()) {
    FileSelectionCanceled();
    return;
  }
  base::ListValue list;
  for (const base::FilePath& path : paths) {
    list.Append(path.value());
  }
  auto resource = std::make_unique<network::ResourceRequest>();
  resource->url = GURL(launcher.ApiOrigin() + "/api/files");
  resource->method = "POST";
  resource->credentials_mode = network::mojom::CredentialsMode::kOmit;
  resource->headers.SetHeader("Authorization",
                              "Bearer " + launcher.browser_token());
  std::unique_ptr<network::SimpleURLLoader> loader =
      network::SimpleURLLoader::Create(std::move(resource), kTrafficAnnotation);
  loader->AttachStringForUpload(
      base::WriteJson(base::DictValue().Set("paths", std::move(list)))
          .value_or("{}"),
      "application/json");
  network::SimpleURLLoader* raw = loader.get();
  raw->DownloadToString(
      Profile::FromWebUI(web_ui())
          ->GetDefaultStoragePartition()
          ->GetURLLoaderFactoryForBrowserProcess()
          .get(),
      base::BindOnce(&PerchShellHandler::OnFilesStored,
                     weak_factory_.GetWeakPtr(), std::move(loader)),
      64 * 1024);
}

void PerchShellHandler::OnFilesStored(
    std::unique_ptr<network::SimpleURLLoader> loader,
    std::optional<std::string> body) {
  const std::string id = std::exchange(pending_files_id_, std::string());
  if (id.empty()) {
    return;
  }
  std::optional<base::Value> parsed =
      body ? base::JSONReader::Read(*body, base::JSON_PARSE_RFC) : std::nullopt;
  const base::ListValue* files =
      parsed && parsed->is_dict() ? parsed->GetDict().FindList("files")
                                  : nullptr;
  if (!files) {
    Reply(id, false,
          base::Value(base::DictValue().Set(
              "message", "Perch couldn't attach those files")));
    return;
  }
  Reply(id, true, base::Value(files->Clone()));
}

}  // namespace perch
