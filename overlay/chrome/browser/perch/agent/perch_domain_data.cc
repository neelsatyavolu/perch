// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/perch_domain_data.h"

#include <memory>
#include <utility>

#include "base/location.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/cancelable_task_tracker.h"
#include "base/time/time.h"
#include "chrome/browser/bookmarks/bookmark_model_factory.h"
#include "chrome/browser/extensions/extension_tab_util.h"
#include "chrome/browser/history/history_service_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/tabs/tab_group_model.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/bookmarks/browser/bookmark_model.h"
#include "components/bookmarks/browser/bookmark_node.h"
#include "components/bookmarks/browser/bookmark_utils.h"
#include "components/bookmarks/common/bookmark_metrics.h"
#include "components/history/core/browser/history_service.h"
#include "components/history/core/browser/history_types.h"
#include "components/history/core/browser/url_row.h"
#include "components/tab_groups/tab_group_color.h"
#include "components/tab_groups/tab_group_visual_data.h"
#include "components/tabs/public/tab_group.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr int kMaxHistory = 5000;
constexpr size_t kMaxChanges = 2000;

base::CancelableTaskTracker& Tracker() {
  static base::NoDestructor<base::CancelableTaskTracker> tracker;
  return *tracker;
}

double Millis(base::Time time) {
  return time.InMillisecondsFSinceUnixEpoch();
}

base::DictValue NodeToDict(const bookmarks::BookmarkNode* node) {
  base::DictValue dict;
  dict.Set("id", base::NumberToString(node->id()));
  dict.Set("title", base::UTF16ToUTF8(node->GetTitle()));
  dict.Set("dateAdded", Millis(node->date_added()));
  if (node->is_url()) {
    dict.Set("url", node->url().spec());
    return dict;
  }
  base::ListValue children;
  for (const auto& child : node->children()) {
    children.Append(NodeToDict(child.get()));
  }
  dict.Set("children", std::move(children));
  return dict;
}

const bookmarks::BookmarkNode* NodeById(bookmarks::BookmarkModel* model,
                                        const std::string* id) {
  int64_t value = 0;
  return id && base::StringToInt64(*id, &value)
             ? bookmarks::GetBookmarkNodeByID(model, value)
             : nullptr;
}

size_t IndexIn(const bookmarks::BookmarkNode* parent,
               const base::DictValue& change) {
  const std::optional<int> index = change.FindInt("index");
  const size_t size = parent->children().size();
  return index && *index >= 0 && static_cast<size_t>(*index) <= size
             ? static_cast<size_t>(*index)
             : size;
}

std::string_view ColorName(tab_groups::TabGroupColorId color) {
  switch (color) {
    case tab_groups::TabGroupColorId::kGrey:
      return "grey";
    case tab_groups::TabGroupColorId::kBlue:
      return "blue";
    case tab_groups::TabGroupColorId::kRed:
      return "red";
    case tab_groups::TabGroupColorId::kYellow:
      return "yellow";
    case tab_groups::TabGroupColorId::kGreen:
      return "green";
    case tab_groups::TabGroupColorId::kPink:
      return "pink";
    case tab_groups::TabGroupColorId::kPurple:
      return "purple";
    case tab_groups::TabGroupColorId::kCyan:
      return "cyan";
    case tab_groups::TabGroupColorId::kOrange:
      return "orange";
    default:
      return "grey";
  }
}

}  // namespace

Profile* AgentProfile() {
  BrowserWindowInterface* last =
      GetLastActiveBrowserWindowInterfaceWithAnyProfile();
  if (last) {
    return last->GetProfile()->GetOriginalProfile();
  }
  std::vector<BrowserWindowInterface*> all = GetAllBrowserWindowInterfaces();
  return all.empty() ? nullptr : all.front()->GetProfile()->GetOriginalProfile();
}

DataResult GetBookmarks(Profile* profile) {
  bookmarks::BookmarkModel* model =
      BookmarkModelFactory::GetForBrowserContext(profile);
  if (!model || !model->loaded()) {
    return base::unexpected("Bookmarks aren't loaded yet");
  }
  base::ListValue roots;
  for (const bookmarks::BookmarkNode* root :
       {model->bookmark_bar_node(), model->other_node(), model->mobile_node()}) {
    roots.Append(NodeToDict(root));
  }
  return base::DictValue().Set("roots", std::move(roots));
}

DataResult ApplyBookmarkChanges(Profile* profile,
                                const base::DictValue& params) {
  bookmarks::BookmarkModel* model =
      BookmarkModelFactory::GetForBrowserContext(profile);
  const base::ListValue* changes = params.FindList("changes");
  if (!model || !model->loaded()) {
    return base::unexpected("Bookmarks aren't loaded yet");
  }
  if (!changes || changes->size() > kMaxChanges) {
    return base::unexpected("Send up to 2000 changes");
  }
  int applied = 0;
  base::DictValue id_map;
  for (size_t i = 0; i < changes->size(); ++i) {
    const base::DictValue* change = (*changes)[i].GetIfDict();
    const std::string* op = change ? change->FindString("op") : nullptr;
    if (!op) {
      continue;
    }
    const std::string* title = change->FindString("title");
    const std::string* url = change->FindString("url");
    if (*op == "add") {
      const bookmarks::BookmarkNode* parent =
          NodeById(model, change->FindString("parentId"));
      if (!parent || parent->is_url() || !title) {
        continue;
      }
      const bookmarks::BookmarkNode* added =
          url ? model->AddURL(parent, IndexIn(parent, *change),
                              base::UTF8ToUTF16(*title), GURL(*url))
              : model->AddFolder(parent, IndexIn(parent, *change),
                                 base::UTF8ToUTF16(*title));
      if (added) {
        id_map.Set(base::NumberToString(i), base::NumberToString(added->id()));
        ++applied;
      }
    } else if (*op == "update") {
      const bookmarks::BookmarkNode* node =
          NodeById(model, change->FindString("id"));
      if (!node || model->is_permanent_node(node)) {
        continue;
      }
      if (title) {
        model->SetTitle(node, base::UTF8ToUTF16(*title),
                        bookmarks::metrics::BookmarkEditSource::kOther);
      }
      if (url && node->is_url() && GURL(*url).is_valid()) {
        model->SetURL(node, GURL(*url),
                      bookmarks::metrics::BookmarkEditSource::kOther);
      }
      ++applied;
    } else if (*op == "move") {
      const bookmarks::BookmarkNode* node =
          NodeById(model, change->FindString("id"));
      const bookmarks::BookmarkNode* parent =
          NodeById(model, change->FindString("parentId"));
      if (!node || !parent || parent->is_url() ||
          model->is_permanent_node(node) || parent->HasAncestor(node)) {
        continue;
      }
      model->Move(node, parent, IndexIn(parent, *change));
      ++applied;
    } else if (*op == "remove") {
      const bookmarks::BookmarkNode* node =
          NodeById(model, change->FindString("id"));
      if (!node || model->is_permanent_node(node)) {
        continue;
      }
      model->Remove(node, bookmarks::metrics::BookmarkEditSource::kOther,
                    FROM_HERE);
      ++applied;
    }
  }
  return base::DictValue()
      .Set("applied", applied)
      .Set("idMap", std::move(id_map));
}

void GetHistory(Profile* profile,
                const base::DictValue& params,
                base::OnceCallback<void(DataResult)> reply) {
  history::HistoryService* history = HistoryServiceFactory::GetForProfile(
      profile, ServiceAccessType::EXPLICIT_ACCESS);
  if (!history) {
    std::move(reply).Run(base::unexpected("History isn't available"));
    return;
  }
  history::QueryOptions options;
  const std::optional<double> since = params.FindDouble("since");
  if (since) {
    options.begin_time = base::Time::FromMillisecondsSinceUnixEpoch(*since);
  }
  const std::optional<int> max = params.FindInt("max");
  options.max_count = max && *max > 0 && *max < kMaxHistory ? *max : kMaxHistory;
  options.duplicate_policy = history::QueryOptions::KEEP_ALL_DUPLICATES;
  history->QueryHistory(
      std::u16string(), options,
      base::BindOnce(
          [](base::OnceCallback<void(DataResult)> reply,
             history::QueryResults found) {
            base::ListValue visits;
            for (const history::URLResult& row : found) {
              visits.Append(base::DictValue()
                                .Set("url", row.url().spec())
                                .Set("title", base::UTF16ToUTF8(row.title()))
                                .Set("time", Millis(row.visit_time())));
            }
            std::move(reply).Run(
                base::DictValue().Set("visits", std::move(visits)));
          },
          std::move(reply)),
      &Tracker());
}

DataResult AddHistory(Profile* profile, const base::DictValue& params) {
  history::HistoryService* history = HistoryServiceFactory::GetForProfile(
      profile, ServiceAccessType::EXPLICIT_ACCESS);
  const base::ListValue* visits = params.FindList("visits");
  if (!history || !visits || visits->size() > kMaxHistory) {
    return base::unexpected("Send up to 5000 visits");
  }
  history::URLRows rows;
  for (const base::Value& item : *visits) {
    const base::DictValue* visit = item.GetIfDict();
    const std::string* url = visit ? visit->FindString("url") : nullptr;
    const std::optional<double> time =
        visit ? visit->FindDouble("time") : std::nullopt;
    if (!url || !time || !GURL(*url).SchemeIsHTTPOrHTTPS()) {
      continue;
    }
    history::URLRow row{GURL(*url)};
    if (const std::string* title = visit->FindString("title")) {
      row.set_title(base::UTF8ToUTF16(*title));
    }
    row.set_last_visit(base::Time::FromMillisecondsSinceUnixEpoch(*time));
    row.set_visit_count(1);
    rows.push_back(std::move(row));
  }
  const int added = static_cast<int>(rows.size());
  history->AddPagesWithDetails(rows, history::SOURCE_SYNCED);
  return base::DictValue().Set("added", added);
}

DataResult GetOpenTabs(Profile* profile) {
  base::ListValue windows;
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    if (browser->GetProfile()->GetOriginalProfile() != profile) {
      continue;
    }
    TabStripModel* model = browser->GetTabStripModel();
    if (!model) {
      continue;
    }
    base::ListValue tabs;
    for (int i = 0; i < model->count(); ++i) {
      content::WebContents* contents = model->GetWebContentsAt(i);
      base::DictValue tab;
      tab.Set("tabId",
              content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId());
      tab.Set("url", contents->GetVisibleURL().spec());
      tab.Set("title", base::UTF16ToUTF8(contents->GetTitle()));
      tab.Set("pinned", model->IsTabPinned(i));
      if (std::optional<tab_groups::TabGroupId> group =
              model->GetTabGroupForTab(i)) {
        tab.Set("groupId", group->ToString());
      }
      tabs.Append(std::move(tab));
    }
    base::ListValue groups;
    if (TabGroupModel* group_model = model->group_model()) {
      for (const tab_groups::TabGroupId& id : group_model->ListTabGroups()) {
        const TabGroup* group = group_model->GetTabGroup(id);
        groups.Append(
            base::DictValue()
                .Set("groupId", id.ToString())
                .Set("title",
                     base::UTF16ToUTF8(group->visual_data()->title()))
                .Set("color", ColorName(group->visual_data()->color())));
      }
    }
    windows.Append(
        base::DictValue()
            .Set("windowId",
                 base::NumberToString(browser->GetSessionID().id()))
            .Set("incognito", browser->GetProfile()->IsOffTheRecord())
            .Set("tabs", std::move(tabs))
            .Set("groups", std::move(groups))
            .Set("splits", base::ListValue()));
  }
  return base::DictValue().Set("windows", std::move(windows));
}

DataResult GetExtensionTabId(const base::DictValue& params) {
  const std::string* target = params.FindString("targetId");
  scoped_refptr<content::DevToolsAgentHost> host =
      target ? content::DevToolsAgentHost::GetForId(*target) : nullptr;
  content::WebContents* contents = host ? host->GetWebContents() : nullptr;
  if (!contents) {
    return base::unexpected("No tab with that target id");
  }
  return base::DictValue().Set(
      "tabId", extensions::ExtensionTabUtil::GetTabId(contents));
}

}  // namespace perch
