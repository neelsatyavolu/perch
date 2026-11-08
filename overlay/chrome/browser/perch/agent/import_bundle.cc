// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/import_bundle.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/path_service.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/importer/profile_writer.h"
#include "chrome/browser/perch/spaces/spaces.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/common/chrome_paths.h"
#include "components/history/core/browser/history_types.h"
#include "components/history/core/browser/url_row.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_string.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_data.h"
#include "components/user_data_importer/common/imported_bookmark_entry.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr int64_t kMaxBundleBytes = 64 * 1024 * 1024;

base::Time FromMillis(std::optional<double> ms) {
  return ms ? base::Time::FromMillisecondsSinceUnixEpoch(*ms) : base::Time::Now();
}

// Reads the file if it is a bundle perchd is applying: inside the user data
// dir's "Perch Import/applying" folder, and not too large.
std::optional<std::string> ReadBundle(base::FilePath path) {
  base::FilePath user_data;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &user_data)) {
    return std::nullopt;
  }
  const base::FilePath allowed = user_data.AppendASCII("Perch Import")
                                     .AppendASCII("applying");
  const base::FilePath real = base::MakeAbsoluteFilePath(path);
  const base::FilePath real_allowed = base::MakeAbsoluteFilePath(allowed);
  if (real.empty() || real_allowed.empty() || !real_allowed.IsParent(real)) {
    return std::nullopt;
  }
  std::string text;
  if (!base::ReadFileToStringWithMaxSize(real, &text, kMaxBundleBytes)) {
    return std::nullopt;
  }
  return text;
}

// Walks one bookmark list (bar, other or mobile) into importer entries.
void AddBookmarkEntries(
    const base::ListValue& nodes,
    bool in_toolbar,
    std::vector<std::u16string>& path,
    std::vector<user_data_importer::ImportedBookmarkEntry>& out) {
  for (const base::Value& item : nodes) {
    const base::DictValue* node = item.GetIfDict();
    const std::string* kind = node ? node->FindString("kind") : nullptr;
    const std::string* title = node ? node->FindString("title") : nullptr;
    if (!kind || !title) {
      continue;
    }
    user_data_importer::ImportedBookmarkEntry entry;
    entry.in_toolbar = in_toolbar;
    entry.title = base::UTF8ToUTF16(*title);
    entry.path = path;
    entry.creation_time = FromMillis(node->FindDouble("added"));
    if (*kind == "url") {
      const std::string* url = node->FindString("url");
      if (!url || !GURL(*url).is_valid()) {
        continue;
      }
      entry.is_folder = false;
      entry.url = GURL(*url);
      out.push_back(std::move(entry));
    } else if (*kind == "folder") {
      const base::ListValue* children = node->FindList("children");
      entry.is_folder = true;
      if (!children || children->empty()) {
        out.push_back(std::move(entry));
        continue;
      }
      path.push_back(base::UTF8ToUTF16(*title));
      AddBookmarkEntries(*children, in_toolbar, path, out);
      path.pop_back();
    }
  }
}

int ApplyBookmarks(ProfileWriter& writer,
                   const base::DictValue& bookmarks,
                   const std::u16string& from) {
  std::vector<user_data_importer::ImportedBookmarkEntry> entries;
  std::vector<std::u16string> path;
  for (const auto [name, in_toolbar] :
       {std::pair("bar", true), std::pair("other", false),
        std::pair("mobile", false)}) {
    if (const base::ListValue* list = bookmarks.FindList(name)) {
      AddBookmarkEntries(*list, in_toolbar, path, entries);
    }
  }
  if (!entries.empty()) {
    writer.AddBookmarks(entries, u"Imported from " + from);
  }
  return static_cast<int>(entries.size());
}

int ApplyHistory(ProfileWriter& writer, const base::ListValue& history) {
  history::URLRows rows;
  for (const base::Value& item : history) {
    const base::DictValue* entry = item.GetIfDict();
    const std::string* url = entry ? entry->FindString("url") : nullptr;
    if (!url || !GURL(*url).SchemeIsHTTPOrHTTPS()) {
      continue;
    }
    history::URLRow row{GURL(*url)};
    if (const std::string* title = entry->FindString("title")) {
      row.set_title(base::UTF8ToUTF16(*title));
    }
    row.set_visit_count(std::max(1, entry->FindInt("visitCount").value_or(1)));
    row.set_typed_count(entry->FindInt("typedCount").value_or(0));
    row.set_last_visit(FromMillis(entry->FindDouble("lastVisit")));
    rows.push_back(std::move(row));
  }
  if (!rows.empty()) {
    writer.AddHistoryPage(rows, history::SOURCE_SAFARI_IMPORTED);
  }
  return static_cast<int>(rows.size());
}

int ApplyPasswords(ProfileWriter& writer, const base::ListValue& passwords) {
  int added = 0;
  for (const base::Value& item : passwords) {
    const base::DictValue* entry = item.GetIfDict();
    const std::string* url = entry ? entry->FindString("url") : nullptr;
    const std::string* realm = entry ? entry->FindString("signonRealm") : nullptr;
    const std::string* username = entry ? entry->FindString("username") : nullptr;
    const std::string* password = entry ? entry->FindString("password") : nullptr;
    if (!url || !realm || !username || !password || !GURL(*url).is_valid()) {
      continue;
    }
    password_manager::PasswordForm form;
    form.url = GURL(*url);
    form.signon_realm = *realm;
    form.username_value = base::UTF8ToUTF16(*username);
    form.password_value =
        password_manager::PasswordString(base::UTF8ToUTF16(*password));
    form.date_created = FromMillis(entry->FindDouble("created"));
    form.scheme = password_manager::PasswordForm::Scheme::kHtml;
    form.type = password_manager::PasswordForm::Type::kImported;
    writer.AddPasswordForm(form);
    ++added;
  }
  return added;
}

int ApplySearchEngines(ProfileWriter& writer, const base::ListValue& engines) {
  TemplateURLService::OwnedTemplateURLVector urls;
  for (const base::Value& item : engines) {
    const base::DictValue* entry = item.GetIfDict();
    const std::string* name = entry ? entry->FindString("name") : nullptr;
    const std::string* keyword = entry ? entry->FindString("keyword") : nullptr;
    const std::string* url = entry ? entry->FindString("url") : nullptr;
    if (!name || !keyword || !url || keyword->empty()) {
      continue;
    }
    TemplateURLData data;
    data.SetShortName(base::UTF8ToUTF16(*name));
    data.SetKeyword(base::UTF8ToUTF16(*keyword));
    data.SetURL(*url);
    if (const std::string* suggest = entry->FindString("suggestUrl")) {
      data.suggestions_url = *suggest;
    }
    urls.push_back(std::make_unique<TemplateURL>(data));
  }
  const int count = static_cast<int>(urls.size());
  if (count) {
    writer.AddKeywords(std::move(urls), /*unique_on_host_and_path=*/true);
  }
  return count;
}

int ApplyTabs(const base::ListValue& windows) {
  BrowserWindowInterface* browser =
      GetLastActiveBrowserWindowInterfaceWithAnyProfile();
  if (!browser) {
    return 0;
  }
  std::vector<SpaceTab> tabs;
  for (const base::Value& item : windows) {
    const base::DictValue* window = item.GetIfDict();
    const base::ListValue* list = window ? window->FindList("tabs") : nullptr;
    for (size_t i = 0; list && i < list->size(); ++i) {
      const base::DictValue* tab = (*list)[i].GetIfDict();
      const std::string* url = tab ? tab->FindString("url") : nullptr;
      if (!url || !GURL(*url).is_valid()) {
        continue;
      }
      const std::string* title = tab->FindString("title");
      tabs.push_back({GURL(*url), title ? base::UTF8ToUTF16(*title) : u"",
                      tab->FindBool("pinned").value_or(false), false});
    }
  }
  if (tabs.empty()) {
    return 0;
  }
  // Imported tabs come in asleep; the one you are on stays where it is.
  OpenTabsAsleep(browser, tabs);
  return static_cast<int>(tabs.size());
}

void Apply(Profile* profile,
           base::OnceCallback<void(DataResult)> reply,
           std::optional<std::string> text) {
  std::optional<base::Value> parsed =
      text ? base::JSONReader::Read(*text, base::JSON_PARSE_RFC) : std::nullopt;
  const base::DictValue* bundle = parsed ? parsed->GetIfDict() : nullptr;
  const base::DictValue* data = bundle ? bundle->FindDict("data") : nullptr;
  if (!profile || !data) {
    std::move(reply).Run(base::unexpected("That import file can't be read"));
    return;
  }
  const std::string* browser_name =
      bundle->FindStringByDottedPath("source.browser");
  const std::u16string from =
      browser_name ? base::UTF8ToUTF16(*browser_name) : u"another browser";
  auto writer = base::MakeRefCounted<ProfileWriter>(profile);
  base::DictValue applied;
  const base::DictValue* bookmarks = data->FindDict("bookmarks");
  applied.Set("bookmarks", bookmarks ? ApplyBookmarks(*writer, *bookmarks, from) : 0);
  const base::ListValue* history = data->FindList("history");
  applied.Set("history", history ? ApplyHistory(*writer, *history) : 0);
  const base::ListValue* passwords = data->FindList("passwords");
  applied.Set("passwords", passwords ? ApplyPasswords(*writer, *passwords) : 0);
  applied.Set("cookies", 0);
  const base::ListValue* tabs = data->FindList("tabs");
  applied.Set("tabs", tabs ? ApplyTabs(*tabs) : 0);
  const base::ListValue* engines = data->FindList("searchEngines");
  applied.Set("searchEngines", engines ? ApplySearchEngines(*writer, *engines) : 0);
  // Everything else stays sealed for a later version.
  base::ListValue skipped;
  for (const auto [key, value] : *data) {
    if (key != "bookmarks" && key != "history" && key != "passwords" &&
        key != "tabs" && key != "searchEngines") {
      skipped.Append(key);
    }
  }
  std::move(reply).Run(base::DictValue()
                           .Set("applied", std::move(applied))
                           .Set("skipped", std::move(skipped)));
}

}  // namespace

void ApplyImportBundle(Profile* profile,
                       const base::DictValue& params,
                       base::OnceCallback<void(DataResult)> reply) {
  const std::string* path = params.FindString("path");
  if (!path) {
    std::move(reply).Run(base::unexpected("path is required"));
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadBundle, base::FilePath(*path)),
      base::BindOnce(&Apply, profile, std::move(reply)));
}

}  // namespace perch
