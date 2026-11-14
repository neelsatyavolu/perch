// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/command_bar/command_bar.h"

#include <algorithm>
#include <map>
#include <memory>
#include <utility>

#include "base/i18n/case_conversion.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/cancelable_task_tracker.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/bookmarks/bookmark_model_factory.h"
#include "chrome/browser/history/history_service_factory.h"
#include "chrome/browser/perch/perch_command_ids.h"
#include "chrome/browser/perch/perch_commands.h"
#include "chrome/browser/perch/webui/perch_ui_source.h"
#include "chrome/browser/perch/webui/perch_page_handler.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/tab_list/tab_list_interface.h"
#include "chrome/browser/ui/browser_commands.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/bubble/webui_bubble_manager.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/grit/generated_resources.h"
#include "components/bookmarks/browser/bookmark_model.h"
#include "components/bookmarks/browser/bookmark_node.h"
#include "components/bookmarks/browser/bookmark_utils.h"
#include "components/history/core/browser/history_service.h"
#include "components/history/core/browser/history_types.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "content/public/browser/web_ui_data_source.h"
#include "content/public/common/url_constants.h"
#include "ui/base/clipboard/scoped_clipboard_writer.h"
#include "ui/base/window_open_disposition.h"
#include "ui/views/bubble/bubble_border.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr size_t kMaxPerKind = 8;

// The bar's command ids (ui-pages command-bar/commands.ts) and what each runs.
constexpr std::pair<std::string_view, int> kCommands[] = {
    {"new-tab", IDC_NEW_TAB},
    {"new-window", IDC_NEW_WINDOW},
    {"new-incognito-window", IDC_NEW_INCOGNITO_WINDOW},
    {"close-duplicate-tabs", IDC_PERCH_CLOSE_DUPLICATE_TABS},
    {"close-tabs-older-than-day", IDC_PERCH_CLOSE_TABS_OLDER_THAN_DAY},
    {"sleep-tab", IDC_PERCH_SLEEP_TAB},
    {"hide-chrome", IDC_PERCH_TOGGLE_HIDE_CHROME},
    {"copy-url", IDC_COPY_URL},
    {"copy-url-markdown", IDC_PERCH_COPY_URL_MARKDOWN},
    {"open-settings", IDC_PERCH_OPEN_SETTINGS},
    {"open-history", IDC_SHOW_HISTORY},
    {"open-downloads", IDC_SHOW_DOWNLOADS},
    {"open-bookmarks", IDC_SHOW_BOOKMARK_MANAGER},
    {"open-extensions", IDC_MANAGE_EXTENSIONS},
};

using Managers =
    std::map<BrowserWindowInterface*, std::unique_ptr<WebUIBubbleManager>>;

Managers& BubbleManagers() {
  static base::NoDestructor<Managers> managers;
  return *managers;
}

base::CancelableTaskTracker& HistoryTracker() {
  static base::NoDestructor<base::CancelableTaskTracker> tracker;
  return *tracker;
}

bool Contains(const std::u16string& haystack, const std::u16string& needle) {
  return base::i18n::ToLower(haystack).find(needle) != std::u16string::npos;
}

base::DictValue Result(std::string_view kind,
                       const std::u16string& title,
                       const GURL& url) {
  return base::DictValue()
      .Set("kind", kind)
      .Set("title", base::UTF16ToUTF8(title.empty() ? base::UTF8ToUTF16(
                                                          url.spec())
                                                    : title))
      .Set("url", url.spec());
}

PerchCommandBarUI* CommandBarOf(content::WebUI* web_ui) {
  return web_ui && web_ui->GetController()
             ? web_ui->GetController()->GetAs<PerchCommandBarUI>()
             : nullptr;
}

}  // namespace

void ToggleCommandBar(BrowserWindowInterface* browser) {
  BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser);
  if (!view) {
    return;
  }
  std::unique_ptr<WebUIBubbleManager>& manager = BubbleManagers()[browser];
  if (!manager) {
    manager = WebUIBubbleManager::Create<PerchCommandBarUI>(
        browser, GURL(kCommandBarURL), IDS_ACCNAME_TAB_SEARCH);
  }
  if (manager->GetBubbleWidget()) {
    manager->CloseBubble();
    return;
  }
  // Centred on the page area like Spotlight: the top sits where a full-height
  // bar (command-bar.css, 420px) is just above the middle, and stays there as
  // results come and go, so the box doesn't move while typing.
  constexpr int kBarMaxHeight = 420;
  const gfx::Rect page = view->contents_container()->GetBoundsInScreen();
  const int top =
      page.y() + std::max(12, (page.height() - kBarMaxHeight) * 2 / 5);
  manager->ShowBubble(gfx::Rect(page.CenterPoint().x(), top, 0, 0),
                      views::BubbleBorder::TOP_CENTER);
}

void ForgetCommandBar(BrowserWindowInterface* browser) {
  BubbleManagers().erase(browser);
}

views::Widget* GetCommandBarWidget(BrowserWindowInterface* browser) {
  auto it = BubbleManagers().find(browser);
  return it != BubbleManagers().end() && it->second
             ? it->second->GetBubbleWidget()
             : nullptr;
}

void ShowCommandBarNow(content::WebUI* web_ui) {
  if (PerchCommandBarUI* bar = CommandBarOf(web_ui); bar && bar->embedder()) {
    bar->embedder()->ShowUI();
  }
}

void CloseCommandBarNow(content::WebUI* web_ui) {
  if (PerchCommandBarUI* bar = CommandBarOf(web_ui); bar && bar->embedder()) {
    bar->embedder()->CloseUI();
  }
}

void QueryCommandBar(Profile* profile,
                     const std::string& text,
                     base::OnceCallback<void(base::ListValue)> reply) {
  const std::u16string query = base::i18n::ToLower(
      base::UTF8ToUTF16(base::TrimWhitespaceASCII(text, base::TRIM_ALL)));
  base::ListValue results;

  // Open tabs, in window order.
  size_t tabs_found = 0;
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    if (browser->GetProfile() != profile) {
      continue;
    }
    TabStripModel* tabs = browser->GetTabStripModel();
    for (int i = 0; i < tabs->count() && tabs_found < kMaxPerKind; ++i) {
      content::WebContents* contents = tabs->GetWebContentsAt(i);
      const GURL& url = contents->GetVisibleURL();
      if (!query.empty() && !Contains(contents->GetTitle(), query) &&
          !Contains(base::UTF8ToUTF16(url.spec()), query)) {
        continue;
      }
      results.Append(Result("tab", contents->GetTitle(), url)
                         .Set("tabId", tabs->GetTabAtIndex(i)
                                           ->GetHandle()
                                           .raw_value()));
      ++tabs_found;
    }
  }
  if (query.empty()) {
    std::move(reply).Run(std::move(results));
    return;
  }

  if (bookmarks::BookmarkModel* model =
          BookmarkModelFactory::GetForBrowserContext(profile);
      model && model->loaded()) {
    bookmarks::QueryFields fields;
    fields.word_phrase_query = std::make_unique<std::u16string>(query);
    for (const bookmarks::BookmarkNode* node :
         bookmarks::GetBookmarksMatchingProperties(model, fields,
                                                   kMaxPerKind)) {
      results.Append(Result("bookmark", node->GetTitle(), node->url()));
    }
  }

  history::HistoryService* history = HistoryServiceFactory::GetForProfile(
      profile, ServiceAccessType::EXPLICIT_ACCESS);
  if (!history) {
    std::move(reply).Run(std::move(results));
    return;
  }
  history::QueryOptions options;
  options.max_count = kMaxPerKind;
  history->QueryHistory(
      query, options,
      base::BindOnce(
          [](base::ListValue results,
             base::OnceCallback<void(base::ListValue)> reply,
             history::QueryResults found) {
            for (const history::URLResult& row : found) {
              results.Append(Result("history", row.title(), row.url()));
            }
            std::move(reply).Run(std::move(results));
          },
          std::move(results), std::move(reply)),
      &HistoryTracker());
}

bool RunCommandBarItem(BrowserWindowInterface* browser,
                       const base::DictValue& item) {
  const std::string* kind = item.FindString("kind");
  if (!browser || !kind) {
    return false;
  }
  if (*kind == "tab") {
    std::optional<int> raw = item.FindInt("tabId");
    tabs::TabInterface* tab =
        raw ? tabs::TabInterface::Handle(*raw).Get() : nullptr;
    BrowserWindowInterface* owner =
        tab ? tab->GetBrowserWindowInterface() : nullptr;
    TabListInterface* list = owner ? TabListInterface::From(owner) : nullptr;
    if (!list) {
      return false;
    }
    list->ActivateTab(tab->GetHandle());
    if (BrowserView* view = BrowserView::GetBrowserViewForBrowser(owner)) {
      view->Activate();
    }
    return true;
  }
  if (*kind == "history" || *kind == "bookmark") {
    const std::string* url = item.FindString("url");
    const GURL target(url ? *url : std::string());
    if (!target.is_valid()) {
      return false;
    }
    browser->OpenURL(
        content::OpenURLParams(target, content::Referrer(),
                               WindowOpenDisposition::kCurrentTab,
                               ui::PAGE_TRANSITION_AUTO_BOOKMARK, false),
        {});
    return true;
  }
  if (*kind == "command") {
    const std::string* id = item.FindString("id");
    for (const auto& [name, command] : kCommands) {
      if (id && *id == name) {
        if (!ExecutePerchCommand(browser, command)) {
          chrome::ExecuteCommand(browser, command);
        }
        return true;
      }
    }
  }
  return false;
}

void CopyUrlAsMarkdown(BrowserWindowInterface* browser) {
  content::WebContents* contents =
      browser->GetTabStripModel()->GetActiveWebContents();
  if (!contents) {
    return;
  }
  std::u16string title = contents->GetTitle();
  base::ReplaceSubstringsAfterOffset(&title, 0, u"]", u"\\]");
  const std::u16string url =
      base::UTF8ToUTF16(contents->GetLastCommittedURL().spec());
  ui::ScopedClipboardWriter(ui::ClipboardBuffer::kCopyPaste)
      .WriteText(u"[" + title + u"](" + url + u")");
}

PerchCommandBarUIConfig::PerchCommandBarUIConfig()
    : DefaultTopChromeWebUIConfig(content::kChromeUIScheme, kCommandBarHost) {}

PerchCommandBarUIConfig::~PerchCommandBarUIConfig() = default;

bool PerchCommandBarUIConfig::ShouldAutoResizeHost() {
  return true;
}

PerchCommandBarUI::PerchCommandBarUI(content::WebUI* web_ui)
    : TopChromeWebUIController(web_ui, /*enable_chrome_send=*/true) {
  content::WebUIDataSource* source = content::WebUIDataSource::CreateAndAdd(
      web_ui->GetWebContents()->GetBrowserContext(), kCommandBarHost);
  ServePerchPages(source, "command-bar.html", PageKind::kPages);
  web_ui->AddMessageHandler(std::make_unique<PerchPageHandler>());
}

PerchCommandBarUI::~PerchCommandBarUI() = default;

WEB_UI_CONTROLLER_TYPE_IMPL(PerchCommandBarUI)

}  // namespace perch
