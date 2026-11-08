// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/side_panel/perch_tab_sync.h"

#include <map>
#include <utility>

#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/escape.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/uuid.h"
#include "chrome/browser/perch/agent/perchd_launcher.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/sessions/session_service.h"
#include "chrome/browser/sessions/session_service_factory.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/sessions/content/session_tab_helper.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/browser_context.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/storage_partition.h"
#include "content/public/browser/web_contents.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr net::NetworkTrafficAnnotationTag kTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("perch_tab_sync", R"(
      semantics {
        sender: "Perch sidebar"
        description:
          "Tells Perch's local agent (perchd, on this Mac's loopback "
          "interface) which tab is active and when tabs change, so each tab "
          "keeps its own side chat."
        trigger: "Tab activation, navigation, title change or close."
        data: "Tab ids, titles and addresses. Never leaves this Mac."
        destination: LOCAL
        internal { contacts { email: "build@perch.invalid" } }
        user_data { type: NONE }
        last_reviewed: "2026-11-06"
      }
      policy {
        cookies_allowed: NO
        setting: "Start Perch with --perch-no-agent to turn the agent off."
        policy_exception_justification: "Local only."
      })");

struct TabState {
  std::string id;
  bool panel_open = false;
};

std::map<int32_t, TabState>& Tabs() {
  static base::NoDestructor<std::map<int32_t, TabState>> tabs;
  return *tabs;
}

// The id a restored tab had before the restart, until the tab gets its state.
class RestoredTabId : public base::SupportsUserData::Data {
 public:
  explicit RestoredTabId(std::string id) : id_(std::move(id)) {}
  const std::string& id() const { return id_; }

  static const void* Key() {
    static const char kKey = 0;
    return &kKey;
  }

 private:
  std::string id_;
};

std::string RestoredIdOf(content::WebContents* contents) {
  if (!contents) {
    return std::string();
  }
  auto* data =
      static_cast<RestoredTabId*>(contents->GetUserData(RestoredTabId::Key()));
  return data ? data->id() : std::string();
}

// Writes the id into the session file, so it comes back after a restart.
void Persist(content::WebContents* contents, const std::string& id) {
  if (!contents) {
    return;
  }
  Profile* profile =
      Profile::FromBrowserContext(contents->GetBrowserContext());
  SessionService* service =
      profile ? SessionServiceFactory::GetForProfile(profile) : nullptr;
  const SessionID window_id =
      sessions::SessionTabHelper::IdForWindowContainingTab(contents);
  const SessionID tab_id = sessions::SessionTabHelper::IdForTab(contents);
  if (service && window_id.is_valid() && tab_id.is_valid()) {
    service->AddTabExtraData(window_id, tab_id, kTabIdExtraDataKey, id);
  }
}

TabState& StateFor(tabs::TabInterface* tab) {
  TabState& state = Tabs()[tab->GetHandle().raw_value()];
  if (state.id.empty()) {
    const std::string restored = RestoredIdOf(tab->GetContents());
    state.id = restored.empty()
                   ? base::Uuid::GenerateRandomV4().AsLowercaseString()
                   : restored;
    Persist(tab->GetContents(), state.id);
  }
  return state;
}

std::string WindowIdFor(BrowserWindowInterface* browser) {
  return base::NumberToString(browser->GetSessionID().id());
}

base::DictValue TabInfo(const std::string& window_id,
                          tabs::TabInterface* tab) {
  content::WebContents* contents = tab->GetContents();
  base::DictValue info;
  info.Set("id", TabIdFor(tab));
  info.Set("windowId", window_id);
  info.Set("title", contents ? base::UTF16ToUTF8(contents->GetTitle())
                             : std::string());
  info.Set("url",
           contents ? contents->GetLastCommittedURL().spec() : std::string());
  if (contents) {
    info.Set("targetId",
             content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId());
    // Private tabs get private chats, which end with the last of them.
    if (contents->GetBrowserContext()->IsOffTheRecord()) {
      info.Set("incognito", true);
    }
  }
  return info;
}

}  // namespace

std::string TabIdFor(tabs::TabInterface* tab) {
  return StateFor(tab).id;
}

std::string PersistedTabId(content::WebContents* contents) {
  if (tabs::TabInterface* tab =
          contents ? tabs::TabInterface::MaybeGetFromContents(contents)
                   : nullptr) {
    auto it = Tabs().find(tab->GetHandle().raw_value());
    if (it != Tabs().end()) {
      return it->second.id;
    }
  }
  return RestoredIdOf(contents);
}

void RestoreTabId(content::WebContents* contents,
                  const std::map<std::string, std::string>& extra_data) {
  auto it = extra_data.find(kTabIdExtraDataKey);
  if (!contents || it == extra_data.end()) {
    return;
  }
  const base::Uuid id = base::Uuid::ParseLowercase(it->second);
  if (id.is_valid()) {
    contents->SetUserData(RestoredTabId::Key(),
                          std::make_unique<RestoredTabId>(it->second));
  }
}

bool IsPanelOpenFor(tabs::TabInterface* tab) {
  auto it = Tabs().find(tab->GetHandle().raw_value());
  return it != Tabs().end() && it->second.panel_open;
}

void SetPanelOpenFor(tabs::TabInterface* tab, bool open) {
  StateFor(tab).panel_open = open;
}

void ForgetTab(tabs::TabInterface* tab) {
  Tabs().erase(tab->GetHandle().raw_value());
}

struct PerchTabSync::Request {
  std::string method;
  std::string path;
  std::optional<base::DictValue> body;
};

// static
PerchTabSync& PerchTabSync::Get() {
  static base::NoDestructor<PerchTabSync> instance;
  return *instance;
}

PerchTabSync::PerchTabSync() = default;
PerchTabSync::~PerchTabSync() = default;

void PerchTabSync::Activate(Profile* profile,
                            const std::string& window_id,
                            tabs::TabInterface* tab) {
  base::DictValue body;
  if (tab) {
    base::DictValue info = TabInfo(window_id, tab);
    info.Remove("windowId");
    body.Set("tab", std::move(info));
  } else {
    body.Set("tab", base::Value());
  }
  Enqueue(profile, "POST",
          "/api/windows/" + base::EscapePath(window_id) + "/active",
          std::move(body));
}

void PerchTabSync::Update(Profile* profile,
                          const std::string& window_id,
                          tabs::TabInterface* tab) {
  base::DictValue info = TabInfo(window_id, tab);
  const std::string id = *info.FindString("id");
  info.Remove("id");
  Enqueue(profile, "PATCH", "/api/tabs/" + base::EscapePath(id),
          std::move(info));
}

void PerchTabSync::Remove(Profile* profile, const std::string& tab_id) {
  Enqueue(profile, "DELETE", "/api/tabs/" + base::EscapePath(tab_id),
          std::nullopt);
}

void PerchTabSync::ResyncAll(Profile* profile) {
  needs_resync_ = false;
  base::ListValue all;
  std::vector<std::pair<std::string, tabs::TabInterface*>> active;
  // Every window of every profile: perchd replaces its whole list with this
  // one, and lets go of the side chats of tabs that are not in it.
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    if (browser->GetType() != BrowserWindowInterface::TYPE_NORMAL) {
      continue;
    }
    TabStripModel* model = browser->GetTabStripModel();
    if (!model) {
      continue;
    }
    const std::string window_id = WindowIdFor(browser);
    for (int i = 0; i < model->count(); ++i) {
      all.Append(TabInfo(window_id, model->GetTabAtIndex(i)));
    }
    active.emplace_back(window_id, model->GetActiveTab());
  }
  base::DictValue body;
  body.Set("tabs", std::move(all));
  Enqueue(profile, "PUT", "/api/tabs", std::move(body));
  for (auto& [window_id, tab] : active) {
    Activate(profile, window_id, tab);
  }
}

void PerchTabSync::Enqueue(Profile* profile,
                           std::string method,
                           std::string path,
                           std::optional<base::DictValue> body) {
  if (!PerchdLauncher::Get().enabled()) {
    return;
  }
  profile_ = profile->GetWeakPtr();
  auto request = std::make_unique<Request>();
  request->method = std::move(method);
  request->path = std::move(path);
  request->body = std::move(body);
  queue_.push_back(std::move(request));
  SendNext();
}

void PerchTabSync::SendNext() {
  if (in_flight_ || queue_.empty() || !profile_) {
    return;
  }
  std::unique_ptr<Request> next = std::move(queue_.front());
  queue_.pop_front();
  const PerchdLauncher& launcher = PerchdLauncher::Get();
  auto resource = std::make_unique<network::ResourceRequest>();
  resource->url = GURL(launcher.ApiOrigin() + next->path);
  resource->method = next->method;
  resource->credentials_mode = network::mojom::CredentialsMode::kOmit;
  resource->headers.SetHeader("Authorization",
                              "Bearer " + launcher.browser_token());
  std::unique_ptr<network::SimpleURLLoader> loader =
      network::SimpleURLLoader::Create(std::move(resource),
                                       kTrafficAnnotation);
  if (next->body) {
    loader->AttachStringForUpload(base::WriteJson(*next->body).value_or("{}"),
                                  "application/json");
  }
  in_flight_ = true;
  network::SimpleURLLoader* raw = loader.get();
  raw->DownloadToString(
      profile_->GetDefaultStoragePartition()
          ->GetURLLoaderFactoryForBrowserProcess()
          .get(),
      base::BindOnce(&PerchTabSync::OnDone, weak_factory_.GetWeakPtr(),
                     std::move(loader)),
      64 * 1024);
}

void PerchTabSync::OnDone(std::unique_ptr<network::SimpleURLLoader> loader,
                          std::optional<std::string> response) {
  in_flight_ = false;
  if (loader->NetError() != 0 && !loader->ResponseInfo()) {
    // perchd is starting or restarting: drop what is queued and send the
    // whole state again shortly.
    queue_.clear();
    if (!needs_resync_) {
      needs_resync_ = true;
      retry_.Start(FROM_HERE, base::Seconds(2),
                   base::BindOnce(
                       [](base::WeakPtr<PerchTabSync> self) {
                         if (self && self->profile_) {
                           self->ResyncAll(self->profile_.get());
                         }
                       },
                       weak_factory_.GetWeakPtr()));
    }
    return;
  }
  SendNext();
}

}  // namespace perch
