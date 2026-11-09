// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/perch_devtools.h"

#include <algorithm>
#include <array>
#include <map>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "base/functional/callback_helpers.h"
#include "base/json/json_reader.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/values.h"
#include "chrome/browser/perch/agent/credential_fill.h"
#include "chrome/browser/perch/agent/import_bundle.h"
#include "chrome/browser/perch/agent/perch_domain_data.h"
#include "chrome/browser/perch/agent/task_status.h"
#include "chrome/browser/perch/side_panel/perch_tab_sync.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/tabs/tab_group_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/tab_groups/tab_group_color.h"
#include "components/tab_groups/tab_group_id.h"
#include "components/tab_groups/tab_group_visual_data.h"
#include "components/tabs/public/tab_group.h"
#include "components/tabs/public/tab_interface.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_agent_host_client.h"
#include "content/public/browser/devtools_agent_host_client_channel.h"
#include "content/public/browser/web_contents.h"
#include "third_party/inspector_protocol/crdtp/dispatch.h"
#include "third_party/inspector_protocol/crdtp/json.h"
#include "ui/gfx/geometry/size.h"

namespace perch {

namespace {

constexpr std::string_view kPrefix = "Perch.";
constexpr int kInvalidParams = -32602;
constexpr int kMethodNotFound = -32601;
constexpr int kServerError = -32000;

struct Reply {
  std::optional<base::DictValue> result;
  int code = 0;
  std::string error;
};

Reply Ok(base::DictValue result = base::DictValue()) {
  return {std::move(result), 0, std::string()};
}

Reply Fail(int code, std::string message) {
  return {std::nullopt, code, std::move(message)};
}

Reply FromData(DataResult result) {
  return result.has_value() ? Ok(std::move(*result))
                            : Fail(kServerError, result.error());
}

// perchd's channel, kept for replies that come later and for events. It is
// the trusted pipe's browser session, which lives until perchd goes away
// (OnPerchdDisconnected).
content::DevToolsAgentHostClientChannel* g_channel = nullptr;

// Holds that keep claimed tabs drawing, by target id. Each hold is bound to a
// weak pointer, so a tab that closes while claimed is safe.
struct Claim {
  // Keeps a background tab drawing and awake; empty with render: false.
  base::ScopedClosureRunner hold;
  // {chatId, client, label}, as perchd sent it.
  base::DictValue owner;
};

std::map<std::string, Claim>& Claims() {
  static base::NoDestructor<std::map<std::string, Claim>> claims;
  return *claims;
}

content::WebContents* ContentsFor(const std::string& target_id) {
  scoped_refptr<content::DevToolsAgentHost> host =
      content::DevToolsAgentHost::GetForId(target_id);
  return host ? host->GetWebContents() : nullptr;
}

tabs::TabInterface* TabFor(const std::string& target_id) {
  content::WebContents* contents = ContentsFor(target_id);
  return contents ? tabs::TabInterface::MaybeGetFromContents(contents)
                  : nullptr;
}

tab_groups::TabGroupColorId ColorFor(const std::string* name) {
  static constexpr std::array<
      std::pair<std::string_view, tab_groups::TabGroupColorId>, 9>
      kColors = {{
          {"grey", tab_groups::TabGroupColorId::kGrey},
          {"blue", tab_groups::TabGroupColorId::kBlue},
          {"red", tab_groups::TabGroupColorId::kRed},
          {"yellow", tab_groups::TabGroupColorId::kYellow},
          {"green", tab_groups::TabGroupColorId::kGreen},
          {"pink", tab_groups::TabGroupColorId::kPink},
          {"purple", tab_groups::TabGroupColorId::kPurple},
          {"cyan", tab_groups::TabGroupColorId::kCyan},
          {"orange", tab_groups::TabGroupColorId::kOrange},
      }};
  if (name) {
    for (const auto& [key, color] : kColors) {
      if (*name == key) {
        return color;
      }
    }
  }
  return tab_groups::TabGroupColorId::kBlue;
}

std::optional<tab_groups::TabGroupId> GroupNamed(TabStripModel* model,
                                                 const std::u16string& title) {
  TabGroupModel* groups = model->group_model();
  if (!groups) {
    return std::nullopt;
  }
  for (const tab_groups::TabGroupId& id : groups->ListTabGroups()) {
    const TabGroup* group = groups->GetTabGroup(id);
    if (group && group->visual_data()->title() == title) {
      return id;
    }
  }
  return std::nullopt;
}

Reply GetInfo() {
  base::DictValue result;
  result.Set("product",
             "Perch/" + std::string(version_info::GetVersionNumber()));
  result.Set("perch", true);
  base::ListValue features;
  for (const char* feature :
       {"setTaskStatus", "revealChat", "askRequested", "getBookmarks",
        "applyBookmarkChanges", "getHistory", "addHistory", "getOpenTabs",
        "getExtensionTabId", "applyImportBundle", "listLogins", "fillLogin",
        "listCards", "fillCard", "perch-artifact", "getTabs", "tabEvents"}) {
    features.Append(feature);
  }
  result.Set("features", std::move(features));
  return Ok(std::move(result));
}

// Groups the tabs by window: a tab joins the group with this title in its own
// window, which is made when there is none.
Reply SetTabGroup(const base::DictValue& params) {
  const base::ListValue* ids = params.FindList("targetIds");
  const std::string* title = params.FindString("title");
  if (!ids || !title || title->empty() || title->size() > 100) {
    return Fail(kInvalidParams, "targetIds and a title are required");
  }
  const std::u16string title16 = base::UTF8ToUTF16(*title);
  std::map<TabStripModel*, std::vector<int>> by_window;
  for (const base::Value& id : *ids) {
    if (!id.is_string()) {
      return Fail(kInvalidParams, "targetIds must be strings");
    }
    tabs::TabInterface* tab = TabFor(id.GetString());
    if (!tab || !tab->GetBrowserWindowInterface()) {
      continue;
    }
    TabStripModel* model =
        tab->GetBrowserWindowInterface()->GetTabStripModel();
    if (!model || !model->SupportsTabGroups()) {
      continue;
    }
    const int index = model->GetIndexOfTab(tab);
    if (index != TabStripModel::kNoTab) {
      by_window[model].push_back(index);
    }
  }
  int grouped = 0;
  for (auto& [model, indices] : by_window) {
    std::sort(indices.begin(), indices.end());
    indices.erase(std::unique(indices.begin(), indices.end()), indices.end());
    if (std::optional<tab_groups::TabGroupId> group =
            GroupNamed(model, title16)) {
      std::erase_if(indices, [&](int index) {
        return model->GetTabGroupForTab(index) == group;
      });
      if (!indices.empty()) {
        model->AddToExistingGroup(indices, *group, /*add_to_end=*/true);
      }
    } else {
      const tab_groups::TabGroupId new_group = model->AddToNewGroup(indices);
      model->ChangeTabGroupVisuals(
          new_group, tab_groups::TabGroupVisualData(
                     title16, ColorFor(params.FindString("color"))));
    }
    grouped += static_cast<int>(indices.size());
  }
  base::DictValue result;
  result.Set("grouped", grouped);
  return Ok(std::move(result));
}

Reply ClaimTab(const base::DictValue& params) {
  const std::string* id = params.FindString("targetId");
  if (!id) {
    return Fail(kInvalidParams, "targetId is required");
  }
  content::WebContents* contents = ContentsFor(*id);
  if (!contents) {
    return Fail(kServerError, "No tab with that target id");
  }
  if (!Claims().contains(*id)) {
    Claim claim;
    if (params.FindBool("render").value_or(true)) {
      claim.hold = contents->IncrementCapturerCount(
          gfx::Size(), /*stay_hidden=*/true,
          /*stay_awake=*/true, /*is_activity=*/false);
    }
    if (const base::DictValue* owner = params.FindDict("owner")) {
      claim.owner = owner->Clone();
    }
    Claims().emplace(*id, std::move(claim));
    if (tabs::TabInterface* tab = TabFor(*id)) {
      EmitPerchEvent("tabClaimed", TabInfo(tab));
    }
  }
  return Ok();
}

Reply ReleaseTab(const base::DictValue& params) {
  const std::string* id = params.FindString("targetId");
  if (!id) {
    return Fail(kInvalidParams, "targetId is required");
  }
  if (Claims().erase(*id)) {
    if (tabs::TabInterface* tab = TabFor(*id)) {
      EmitPerchEvent("tabReleased", TabInfo(tab));
    }
  }
  return Ok();
}

// Every tab in every window and profile, incognito ones flagged (spec 5.8).
Reply GetTabs() {
  base::ListValue list;
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    TabStripModel* model = browser->GetTabStripModel();
    if (!model) {
      continue;
    }
    for (int i = 0; i < model->count(); ++i) {
      list.Append(TabInfo(model->GetTabAtIndex(i)));
    }
  }
  return Ok(base::DictValue().Set("tabs", std::move(list)));
}

Reply SetTaskStatusCommand(const base::DictValue& params) {
  const std::string* chat = params.FindString("chatId");
  const std::string* status = params.FindString("status");
  const base::ListValue* ids = params.FindList("targetIds");
  if (!chat || !status || !ids) {
    return Fail(kInvalidParams, "chatId, status and targetIds are required");
  }
  TaskState state = TaskState::kIdle;
  if (*status == "running") {
    state = TaskState::kRunning;
  } else if (*status == "waiting") {
    state = TaskState::kWaiting;
  } else if (*status != "idle") {
    return Fail(kInvalidParams, "status is idle, running or waiting");
  }
  std::vector<std::string> targets;
  for (const base::Value& id : *ids) {
    if (id.is_string()) {
      targets.push_back(id.GetString());
    }
  }
  const std::string* title = params.FindString("title");
  SetTaskStatus(*chat, state, targets, title ? *title : std::string());
  return Ok();
}

Reply RevealChatCommand(const base::DictValue& params) {
  const std::string* chat = params.FindString("chatId");
  const std::string* mode = params.FindString("mode");
  const std::string* tab = params.FindString("tabId");
  if (!chat || !mode) {
    return Fail(kInvalidParams, "chatId and mode are required");
  }
  const bool side = *mode == "side" && tab;
  if (!RevealChat(*chat, tab ? *tab : std::string(), side)) {
    return Fail(kServerError, "Perch couldn't show that chat");
  }
  return Ok();
}

Reply Dispatch(std::string_view method, const base::DictValue& params) {
  if (method == "setTaskStatus") {
    return SetTaskStatusCommand(params);
  }
  if (method == "revealChat") {
    return RevealChatCommand(params);
  }
  if (method == "getBookmarks") {
    return FromData(GetBookmarks(AgentProfile()));
  }
  if (method == "applyBookmarkChanges") {
    return FromData(ApplyBookmarkChanges(AgentProfile(), params));
  }
  if (method == "addHistory") {
    return FromData(AddHistory(AgentProfile(), params));
  }
  if (method == "getOpenTabs") {
    return FromData(GetOpenTabs(AgentProfile()));
  }
  if (method == "listCards") {
    return FromData(ListCards(params));
  }
  if (method == "getExtensionTabId") {
    return FromData(GetExtensionTabId(params));
  }
  if (method == "getInfo") {
    return GetInfo();
  }
  if (method == "setTabGroup") {
    return SetTabGroup(params);
  }
  if (method == "claimTab") {
    return ClaimTab(params);
  }
  if (method == "releaseTab") {
    return ReleaseTab(params);
  }
  if (method == "getTabs") {
    return GetTabs();
  }
  return Fail(kMethodNotFound, "'Perch." + std::string(method) +
                                   "' wasn't found");
}

void Send(content::DevToolsAgentHostClientChannel* channel,
          int call_id,
          Reply reply) {
  base::DictValue message;
  message.Set("id", call_id);
  if (reply.result) {
    message.Set("result", std::move(*reply.result));
  } else {
    base::DictValue error;
    error.Set("code", reply.code);
    error.Set("message", reply.error);
    message.Set("error", std::move(error));
  }
  const std::string json = base::WriteJson(message).value_or("{}");
  std::vector<uint8_t> cbor;
  if (!crdtp::json::ConvertJSONToCBOR(crdtp::SpanFrom(json), &cbor).ok()) {
    return;
  }
  channel->DispatchProtocolMessageToClient(std::move(cbor));
}

}  // namespace

bool MaybeHandleCommand(content::DevToolsAgentHostClientChannel* channel,
                        base::span<const uint8_t> message) {
  crdtp::Dispatchable dispatchable(crdtp::SpanFrom(message), std::string_view(),
                                  [](int, crdtp::span<uint8_t>,
                                     crdtp::span<uint8_t>, std::string_view) {});
  if (!dispatchable.ok() || !dispatchable.HasCallId()) {
    return false;
  }
  const std::string_view method(
      reinterpret_cast<const char*>(dispatchable.Method().data()),
      dispatchable.Method().size());
  if (!method.starts_with(kPrefix)) {
    return false;
  }
  // Only perchd's pipe is trusted. Everyone else gets "not found", the same
  // answer as in a browser without the domain.
  if (!channel->GetClient()->IsTrusted()) {
    Send(channel, dispatchable.CallId(),
         Fail(kMethodNotFound, "'" + std::string(method) + "' wasn't found"));
    return true;
  }
  base::DictValue params;
  if (!dispatchable.Params().empty()) {
    std::string json;
    if (!crdtp::json::ConvertCBORToJSON(dispatchable.Params(), &json).ok()) {
      Send(channel, dispatchable.CallId(),
           Fail(kInvalidParams, "Unreadable params"));
      return true;
    }
    std::optional<base::Value> value = base::JSONReader::Read(json, base::JSON_PARSE_RFC);
    if (!value || !value->is_dict()) {
      Send(channel, dispatchable.CallId(),
           Fail(kInvalidParams, "params must be an object"));
      return true;
    }
    params = std::move(*value).TakeDict();
  }
  g_channel = channel;
  const std::string_view name = method.substr(kPrefix.size());
  const int call_id = dispatchable.CallId();
  // Methods that answer later; the reply goes out only while the channel is
  // still perchd's.
  auto later = base::BindOnce(
      [](content::DevToolsAgentHostClientChannel* from, int id,
         DataResult result) {
        if (g_channel == from) {
          Send(from, id, FromData(std::move(result)));
        }
      },
      channel, call_id);
  if (name == "getHistory" || name == "applyImportBundle") {
    if (!AgentProfile()) {
      Send(channel, call_id, Fail(kServerError, "No profile"));
      return true;
    }
    auto run = name == "getHistory" ? &GetHistory : &ApplyImportBundle;
    run(AgentProfile(), params, std::move(later));
    return true;
  }
  if (name == "listLogins" || name == "fillLogin" || name == "fillCard") {
    auto run = name == "listLogins"  ? &ListLogins
               : name == "fillLogin" ? &FillLogin
                                     : &FillCard;
    run(params, std::move(later));
    return true;
  }
  Send(channel, call_id, Dispatch(name, params));
  return true;
}

void EmitPerchEvent(std::string_view method, base::DictValue params) {
  if (!g_channel) {
    return;
  }
  base::DictValue message;
  message.Set("method", "Perch." + std::string(method));
  message.Set("params", std::move(params));
  const std::string json = base::WriteJson(message).value_or("{}");
  std::vector<uint8_t> cbor;
  if (crdtp::json::ConvertJSONToCBOR(crdtp::SpanFrom(json), &cbor).ok()) {
    g_channel->DispatchProtocolMessageToClient(std::move(cbor));
  }
}

base::DictValue TabInfo(tabs::TabInterface* tab) {
  content::WebContents* contents = tab->GetContents();
  BrowserWindowInterface* browser = tab->GetBrowserWindowInterface();
  const std::string target_id =
      content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId();
  base::DictValue info;
  info.Set("tabId", TabIdFor(tab));
  info.Set("targetId", target_id);
  info.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
  info.Set("url", contents->GetVisibleURL().spec());
  info.Set("pinned", tab->IsPinned());
  info.Set("active", tab->IsActivated());
  if (browser) {
    Profile* profile = browser->GetProfile();
    info.Set("windowId", base::NumberToString(browser->GetSessionID().id()));
    info.Set("profile",
             profile->GetOriginalProfile()->GetBaseName().AsUTF8Unsafe());
    info.Set("incognito", profile->IsOffTheRecord());
  }
  auto claim = Claims().find(target_id);
  if (claim != Claims().end() && !claim->second.owner.empty()) {
    info.Set("owner", claim->second.owner.Clone());
  }
  return info;
}

bool IsClaimedByAgent(const content::WebContents* contents) {
  if (!contents) {
    return false;
  }
  for (const auto& [target_id, hold] : Claims()) {
    if (ContentsFor(target_id) == contents) {
      return true;
    }
  }
  return false;
}

bool IsPerchdConnected() {
  return g_channel != nullptr;
}

void OnPerchdDisconnected() {
  g_channel = nullptr;
  Claims().clear();
  ClearAllTaskStatus();
}

}  // namespace perch
