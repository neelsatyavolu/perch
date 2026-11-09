// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_file_chooser.h"

#include <memory>
#include <utility>

#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "chrome/browser/perch/agent/perchd_launcher.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/select_file_policy/chrome_select_file_policy.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("perch_picked_files", R"(
      semantics {
        sender: "Perch settings"
        description:
          "Tells Perch's local agent (perchd, on this Mac's loopback "
          "interface) which file the person picked, so pages only hold ids."
        trigger: "Choosing a file in Perch's settings or import pages."
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

// The open panel for one file; owns itself until the person answers.
class OneFileChooser : public ui::SelectFileDialog::Listener {
 public:
  OneFileChooser(content::WebContents* contents,
                 const std::vector<std::string>& extensions,
                 base::OnceCallback<void(std::optional<base::Value>)> reply)
      : profile_(Profile::FromBrowserContext(contents->GetBrowserContext())
                     ->GetWeakPtr()),
        reply_(std::move(reply)) {
    ui::SelectFileDialog::FileTypeInfo types;
    if (!extensions.empty()) {
      types.extensions.emplace_back(extensions.begin(), extensions.end());
    }
    dialog_ = ui::SelectFileDialog::Create(
        this, std::make_unique<ChromeSelectFilePolicy>(contents));
    dialog_->SelectFile(ui::SelectFileDialog::SELECT_OPEN_FILE, u"Choose a file",
                        base::FilePath(), extensions.empty() ? nullptr : &types,
                        0, base::FilePath::StringType(),
                        contents->GetTopLevelNativeWindow());
  }

  void FileSelected(const ui::SelectedFileInfo& file, int index) override {
    if (!profile_) {
      Finish(std::nullopt);
      return;
    }
    StorePickedFiles(
        profile_.get(), {file.path()},
        base::BindOnce(
            [](OneFileChooser* self, std::optional<base::ListValue> files) {
              if (!files || files->empty() || !(*files)[0].is_dict()) {
                self->Finish(std::nullopt);
                return;
              }
              const base::DictValue& first = (*files)[0].GetDict();
              const std::string* id = first.FindString("id");
              const std::string* name = first.FindString("name");
              self->Finish(id && name ? std::optional<base::Value>(base::Value(
                                            base::DictValue()
                                                .Set("id", *id)
                                                .Set("name", *name)))
                                      : std::nullopt);
            },
            base::Unretained(this)));
  }

  void FileSelectionCanceled() override { Finish(std::nullopt); }

 private:
  ~OneFileChooser() override { dialog_->ListenerDestroyed(); }

  void Finish(std::optional<base::Value> choice) {
    std::move(reply_).Run(std::move(choice));
    delete this;
  }

  base::WeakPtr<Profile> profile_;
  base::OnceCallback<void(std::optional<base::Value>)> reply_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
};

// A save or open panel that answers with the path; owns itself until then.
class PathChooser : public ui::SelectFileDialog::Listener {
 public:
  PathChooser(content::WebContents* contents,
              ui::SelectFileDialog::Type type,
              const std::u16string& title,
              const base::FilePath& suggested_name,
              const std::string& extension,
              base::OnceCallback<void(std::optional<base::FilePath>)> reply)
      : reply_(std::move(reply)) {
    ui::SelectFileDialog::FileTypeInfo types;
    types.extensions.push_back({extension});
    dialog_ = ui::SelectFileDialog::Create(
        this, std::make_unique<ChromeSelectFilePolicy>(contents));
    dialog_->SelectFile(type, title, suggested_name, &types, 1, extension,
                        contents->GetTopLevelNativeWindow());
  }

  void FileSelected(const ui::SelectedFileInfo& file, int index) override {
    Finish(file.path());
  }
  void FileSelectionCanceled() override { Finish(std::nullopt); }

 private:
  ~PathChooser() override { dialog_->ListenerDestroyed(); }

  void Finish(std::optional<base::FilePath> path) {
    std::move(reply_).Run(std::move(path));
    delete this;
  }

  base::OnceCallback<void(std::optional<base::FilePath>)> reply_;
  scoped_refptr<ui::SelectFileDialog> dialog_;
};

}  // namespace

void ChooseSavePath(
    content::WebContents* contents,
    const base::FilePath& suggested_name,
    const std::string& extension,
    base::OnceCallback<void(std::optional<base::FilePath>)> reply) {
  new PathChooser(contents, ui::SelectFileDialog::SELECT_SAVEAS_FILE,
                  u"Save backup", suggested_name, extension, std::move(reply));
}

void ChooseOpenPath(
    content::WebContents* contents,
    const std::string& extension,
    base::OnceCallback<void(std::optional<base::FilePath>)> reply) {
  new PathChooser(contents, ui::SelectFileDialog::SELECT_OPEN_FILE,
                  u"Choose a backup", base::FilePath(), extension,
                  std::move(reply));
}

void StorePickedFiles(
    Profile* profile,
    std::vector<base::FilePath> paths,
    base::OnceCallback<void(std::optional<base::ListValue>)> reply) {
  const PerchdLauncher& launcher = PerchdLauncher::Get();
  if (launcher.ApiOrigin().empty() || paths.empty()) {
    std::move(reply).Run(std::nullopt);
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
      profile->GetDefaultStoragePartition()
          ->GetURLLoaderFactoryForBrowserProcess()
          .get(),
      base::BindOnce(
          [](std::unique_ptr<network::SimpleURLLoader> loader,
             base::OnceCallback<void(std::optional<base::ListValue>)> reply,
             std::optional<std::string> body) {
            std::optional<base::Value> parsed =
                body ? base::JSONReader::Read(*body, base::JSON_PARSE_RFC)
                     : std::nullopt;
            const base::ListValue* files =
                parsed && parsed->is_dict()
                    ? parsed->GetDict().FindList("files")
                    : nullptr;
            std::move(reply).Run(files ? std::optional(files->Clone())
                                       : std::nullopt);
          },
          std::move(loader), std::move(reply)),
      64 * 1024);
}

void ChooseOneFile(content::WebContents* contents,
                   const std::vector<std::string>& extensions,
                   base::OnceCallback<void(std::optional<base::Value>)> reply) {
  new OneFileChooser(contents, extensions, std::move(reply));
}

}  // namespace perch
