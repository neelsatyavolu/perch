// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/snapshot/chrome_snapshot.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/threading/thread_restrictions.h"
#include "base/time/time.h"
#include "chrome/app/chrome_command_ids.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/performance_manager/policies/memory_saver_mode_policy.h"
#include "chrome/browser/perch/agent/credential_fill.h"
#include "chrome/browser/perch/agent/import_bundle.h"
#include "chrome/browser/autofill/personal_data_manager_factory.h"
#include "components/autofill/core/browser/data_manager/payments/payments_data_manager.h"
#include "components/autofill/core/browser/data_manager/personal_data_manager.h"
#include "components/autofill/core/browser/data_model/payments/credit_card.h"
#include "content/public/browser/render_frame_host.h"
#include "chrome/browser/perch/agent/perch_domain_data.h"
#include "chrome/browser/perch/agent/task_status.h"
#include "chrome/browser/perch/command_bar/command_bar.h"
#include "chrome/browser/perch/memory_saver/sleep_controller.h"
#include "chrome/browser/perch/perch_command_ids.h"
#include "chrome/browser/perch/perch_commands.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/spaces/spaces.h"
#include "chrome/browser/perch/tab_tools/tab_tools.h"
#include "chrome/browser/perch/toolbar/perch_profile_menu.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/translate/chrome_translate_client.h"
#include "components/translate/core/browser/translate_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "components/prefs/pref_service.h"
#include "components/viz/common/frame_sinks/copy_output_request.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/web_contents.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/compositor/layer.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr char kSnapshotSwitch[] = "perch-chrome-snapshot";
constexpr char kStatesSwitch[] = "perch-snapshot-states";
constexpr base::TimeDelta kSettle = base::Milliseconds(1500);

bool g_started = false;

void WritePng(base::FilePath path, SkBitmap bitmap) {
  std::optional<std::vector<uint8_t>> png =
      gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, /*discard_transparency=*/false);
  if (!png || !base::WriteFile(path, *png)) {
    LOG(ERROR) << "Perch snapshot: could not write " << path;
    return;
  }
  LOG(WARNING) << "Perch snapshot: wrote " << path;
}

// Renders one state after another, then quits.
class Snapshotter {
 public:
  Snapshotter(BrowserWindowInterface* browser,
              base::FilePath dir,
              std::vector<std::string> states)
      : browser_(browser), dir_(std::move(dir)), states_(std::move(states)) {}

  void Next() {
    if (index_ >= states_.size()) {
      chrome::AttemptExit();
      return;
    }
    Apply(states_[index_]);
    // "pause" holds the window for a probe over DevTools.
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&Snapshotter::Capture, base::Unretained(this)),
        states_[index_] == "pause" ? base::Seconds(30) : kSettle);
  }

 private:
  void Apply(const std::string& state) {
    PrefService* prefs = browser_->GetProfile()->GetPrefs();
    if (state.starts_with("theme-")) {
      prefs->SetString(prefs::kAppearanceTheme, state.substr(6));
    } else if (state.starts_with("accent-")) {
      prefs->SetString(prefs::kAppearanceAccent, state.substr(7));
    } else if (state == "hidden-chrome") {
      prefs->SetBoolean(prefs::kAppearanceHideChrome, true);
      // The address bar has focus in a new window, which shows the bars.
      if (content::WebContents* page =
              browser_->GetTabStripModel()->GetActiveWebContents()) {
        page->Focus();
      }
    } else if (state == "duplicate-tabs") {
      // Two copies of one page (one with a #), and a pinned copy.
      for (const char* url :
           {"chrome://version", "chrome://version/#a", "chrome://history",
            "chrome://version", "chrome://history"}) {
        Open(url);
      }
      browser_->GetTabStripModel()->SetTabPinned(1, true);
    } else if (state == "close-duplicates") {
      ExecutePerchCommand(browser_, IDC_PERCH_CLOSE_DUPLICATE_TABS);
      LogTabs("after closing duplicates");
    } else if (state == "old-tabs") {
      // Every background, unpinned tab is "older than a day" two days on.
      TabStripModel* tabs = browser_->GetTabStripModel();
      LOG(WARNING) << "Perch snapshot: "
                   << FindOlderThan(*tabs, base::Days(1),
                                    base::Time::Now() + base::Days(2))
                          .size()
                   << " of " << tabs->count() << " tabs older than a day";
    } else if (state == "spaces") {
      // Space A has the open tabs; a new space B gets one tab; back to A.
      auto urls = [&] {
        TabStripModel* tabs = browser_->GetTabStripModel();
        std::string list = "[" + base::NumberToString(tabs->count()) + "]";
        for (int i = 0; i < tabs->count(); ++i) {
          list += " " + tabs->GetWebContentsAt(i)->GetVisibleURL().spec() +
                  (tabs->GetWebContentsAt(i)->GetController().NeedsReload()
                       ? "(asleep)"
                       : "");
        }
        return list;
      };
      const std::string before = urls();
      NewSpace(browser_);
      const std::string in_b = urls();
      LOG(WARNING) << "Perch snapshot: spaces pref after new: "
                   << browser_->GetProfile()
                          ->GetPrefs()
                          ->GetList(prefs::kSpaces)
                          .DebugString();
      SwitchToSpace(browser_, 0);
      LOG(WARNING) << "Perch snapshot: spaces A:" << before << " / B:" << in_b
                   << " / back in A:" << urls() << " / names:"
                   << ListSpaces(browser_->GetProfile()).size();
    } else if (state == "translate-open") {
      browser_->GetTabStripModel()->GetActiveWebContents()->GetController()
          .LoadURL(GURL("https://fr.wikipedia.org/wiki/Paris"),
                   content::Referrer(), ui::PAGE_TRANSITION_TYPED,
                   std::string());
    } else if (state == "translate") {
      // The page from "translate-open", translated French to English.
      if (auto* client = ChromeTranslateClient::FromWebContents(
              browser_->GetTabStripModel()->GetActiveWebContents())) {
        client->GetTranslateManager()->TranslatePage("fr", "en",
                                                     /*triggered_from_menu=*/true);
      }
    } else if (state == "agent") {
      // The Perch domain's data calls and a running task's dot.
      Profile* profile = AgentProfile();
      DataResult tabs = GetOpenTabs(profile);
      DataResult added = ApplyBookmarkChanges(
          profile, *base::JSONReader::ReadDict(
                       R"({"changes":[{"op":"add","parentId":"1",)"
                       R"("title":"Perch","url":"https://perchbrowser.com/"}]})",
                       base::JSON_PARSE_RFC));
      DataResult marks = GetBookmarks(profile);
      LOG(WARNING) << "Perch snapshot: agent tabs="
                   << (tabs.has_value() ? tabs->DebugString().size() : 0)
                   << " added=" << (added.has_value() ? added->DebugString() : added.error())
                   << " bookmarks has Perch="
                   << (marks.has_value() &&
                       marks->DebugString().find("perchbrowser.com") !=
                           std::string::npos);
      TabStripModel* model = browser_->GetTabStripModel();
      if (model->count() > 1) {
        SetTaskStatus("chat-1", TaskState::kRunning,
                      {content::DevToolsAgentHost::GetOrCreateFor(
                           model->GetWebContentsAt(1))
                           ->GetId()},
                      std::string());
      }
    } else if (state == "import") {
      // A small bundle in the folder perchd uses, applied as perchd would.
      base::FilePath dir = browser_->GetProfile()->GetPath().DirName()
                               .AppendASCII("Perch Import")
                               .AppendASCII("applying");
      base::ScopedAllowBlockingForTesting allow;
      base::CreateDirectory(dir);
      const base::FilePath file = dir.AppendASCII("test.json");
      base::WriteFile(file, R"({"version":1,"id":"t","created":0,
        "source":{"browser":"Safari","profile":"Default"},
        "data":{"bookmarks":{"bar":[{"kind":"url","title":"Example",
        "url":"https://example.com/"}],"other":[],"mobile":[]},
        "history":[{"url":"https://example.org/","title":"Org",
        "visitCount":3,"typedCount":1,"lastVisit":1700000000000}],
        "searchEngines":[{"name":"Kagi","keyword":"kagi",
        "url":"https://kagi.com/search?q={searchTerms}","isDefault":false}],
        "extensions":[{"id":"x","name":"X","version":"1"}]}})");
      ApplyImportBundle(
          browser_->GetProfile(),
          base::DictValue().Set("path", file.value()),
          base::BindOnce([](DataResult result) {
            LOG(WARNING) << "Perch snapshot: import "
                         << (result.has_value() ? result->DebugString()
                                                : result.error());
          }));
    } else if (state == "fill-open") {
      browser_->GetTabStripModel()->GetActiveWebContents()->GetController()
          .LoadURL(GURL("data:text/html,<form><input autocomplete=cc-number>"
                        "<input autocomplete=cc-exp>"
                        "<input autocomplete=cc-csc></form>"),
                   content::Referrer(), ui::PAGE_TRANSITION_TYPED,
                   std::string());
    } else if (state == "fill") {
      // A saved card, listed by last four and filled into the page.
      content::WebContents* page =
          browser_->GetTabStripModel()->GetActiveWebContents();
      autofill::CreditCard card;
      card.SetRawInfo(autofill::CREDIT_CARD_NUMBER, u"4111111111111111");
      card.SetRawInfo(autofill::CREDIT_CARD_NAME_FULL, u"Test Person");
      card.SetExpirationMonth(12);
      card.SetExpirationYear(2030);
      autofill::PersonalDataManagerFactory::GetForBrowserContext(
          page->GetBrowserContext())
          ->payments_data_manager()
          .AddCreditCard(card);
    } else if (state == "fill-run") {
      content::WebContents* page =
          browser_->GetTabStripModel()->GetActiveWebContents();
      const std::string target =
          content::DevToolsAgentHost::GetOrCreateFor(page)->GetId();
      DataResult cards = ListCards(base::DictValue().Set("targetId", target));
      const std::string* id =
          cards.has_value() && !cards->FindList("cards")->empty()
              ? (*cards->FindList("cards"))[0].GetDict().FindString("cardId")
              : nullptr;
      LOG(WARNING) << "Perch snapshot: cards "
                   << (cards.has_value() ? cards->DebugString() : cards.error());
      if (id) {
        FillCard(base::DictValue().Set("targetId", target).Set("cardId", *id),
                 base::BindOnce(
                     [](base::WeakPtr<content::WebContents> page,
                        DataResult result) {
                       LOG(WARNING) << "Perch snapshot: fill "
                                    << (result.has_value()
                                            ? result->DebugString()
                                            : result.error());
                       if (page) {
                         page->GetPrimaryMainFrame()
                             ->ExecuteJavaScriptForTests(
                                 u"[...document.querySelectorAll('input')]"
                                 u".map(i => i.value.length + ':' + "
                                 u"i.hasAttribute('data-perch-filled'))"
                                 u".join(' ')",
                                 base::BindOnce([](base::Value v) {
                                   LOG(WARNING) << "Perch snapshot: fields "
                                                << v.DebugString();
                                 }),
                                 content::ISOLATED_WORLD_ID_GLOBAL);
                       }
                     },
                     page->GetWeakPtr()));
      }
    } else if (state == "command-bar") {
      ExecutePerchCommand(browser_, IDC_PERCH_COMMAND_BAR);
      QueryCommandBar(browser_->GetProfile(), "histor",
                      base::BindOnce([](base::ListValue results) {
                        LOG(WARNING) << "Perch snapshot: command bar "
                                        "query histor: "
                                     << results.DebugString();
                      }));
    } else if (state == "profile-menu") {
      // The profile menu's items, then New Tab run from it.
      PerchProfileMenuModel menu(browser_);
      std::string items;
      for (size_t i = 0; i < menu.GetItemCount(); ++i) {
        items += menu.GetTypeAt(i) == ui::MenuModel::TYPE_SEPARATOR
                     ? std::string(" |")
                     : " " + base::UTF16ToUTF8(menu.GetLabelAt(i));
      }
      const int before = browser_->GetTabStripModel()->count();
      menu.ExecuteCommand(IDC_NEW_TAB, 0);
      LOG(WARNING) << "Perch snapshot: profile menu:" << items
                   << " / tabs " << before << " -> "
                   << browser_->GetTabStripModel()->count();
    } else if (state == "sleep-open") {
      Open("chrome://version");
      Open("chrome://history");
    } else if (state == "sleep") {
      // Sleep Tab on a background tab opened by "sleep-open", the rules, and
      // the timeout.
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&Snapshotter::CheckSleep, base::Unretained(this)),
          base::Milliseconds(500));
    } else if (state == "tabs") {
      TabStripModel* tabs = browser_->GetTabStripModel();
      for (const char* url : {"about:blank", "chrome://version",
                              "chrome://perch-settings", "chrome://flags",
                              "chrome://perch-memory", "chrome://downloads",
                              "chrome://history"}) {
        if (tabs->count() >= 8) {
          break;
        }
        BrowserView::GetBrowserViewForBrowser(browser_)
            ->browser()
            ->OpenURL(content::OpenURLParams(
                          GURL(url), content::Referrer(),
                          WindowOpenDisposition::kNewBackgroundTab,
                          ui::PAGE_TRANSITION_TYPED, false),
                      {});
      }
    }
  }

  void Open(const char* url) {
    BrowserView::GetBrowserViewForBrowser(browser_)->browser()->OpenURL(
        content::OpenURLParams(GURL(url), content::Referrer(),
                               WindowOpenDisposition::kNewBackgroundTab,
                               ui::PAGE_TRANSITION_TYPED, false),
        {});
  }

  void LogTabs(const char* when) {
    TabStripModel* tabs = browser_->GetTabStripModel();
    std::string list;
    for (int i = 0; i < tabs->count(); ++i) {
      list += (tabs->IsTabPinned(i) ? " [pinned]" : " ") +
              tabs->GetWebContentsAt(i)->GetVisibleURL().spec();
    }
    LOG(WARNING) << "Perch snapshot: tabs " << when << ":" << list;
  }

  void CheckSleep() {
    TabStripModel* tabs = browser_->GetTabStripModel();
    const int last = tabs->count() - 1;
    SleepTab(tabs->GetTabAtIndex(last));
    Profile* profile = browser_->GetProfile();
    SetSleepRules(profile, {*ParseSleepPattern("keep.example")});
    const auto& token = profile->UniqueToken();
    auto* policy =
        performance_manager::policies::MemorySaverModePolicy::GetInstance();
    LOG(WARNING) << "Perch snapshot: slept tab discarded="
                 << tabs->GetWebContentsAt(last)->WasDiscarded()
                 << " exempt(app.keep.example)="
                 << IsSleepExempt(token, GURL("https://app.keep.example/"))
                 << " exempt(other.example)="
                 << IsSleepExempt(token, GURL("https://other.example/"))
                 << " timeout_minutes=" << GetSleepTimeoutMinutes()
                 << " policy_timeout="
                 << (policy ? policy->GetTimeBeforeDiscardForTesting()
                            : base::TimeDelta());
  }

  void Capture() {
    BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
    views::Widget* widget = view ? view->GetWidget() : nullptr;
    // The command bar state draws the bar's own bubble.
    if (states_[index_] == "command-bar") {
      widget = GetCommandBarWidget(browser_);
    }
    ui::Layer* layer = widget ? widget->GetLayer() : nullptr;
    if (!layer) {
      LOG(ERROR) << "Perch snapshot: the window has no layer";
      ++index_;
      Next();
      return;
    }
    const base::FilePath path = dir_.AppendASCII(states_[index_] + ".png");
    layer->RequestCopyOfOutput(std::make_unique<viz::CopyOutputRequest>(
        viz::CopyOutputRequest::ResultFormat::RGBA,
        viz::CopyOutputRequest::ResultDestination::kSystemMemory,
        base::BindOnce(&Snapshotter::Done, base::Unretained(this), path)));
  }

  void Done(base::FilePath path, std::unique_ptr<viz::CopyOutputResult> r) {
    if (r && !r->IsEmpty()) {
      auto scoped = r->ScopedAccessSkBitmap();
      SkBitmap bitmap = scoped.GetOutScopedBitmap();
      base::ThreadPool::PostTask(
          FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
          base::BindOnce(&WritePng, path, std::move(bitmap)));
    } else {
      LOG(ERROR) << "Perch snapshot: the compositor returned no frame for "
                 << path;
    }
    ++index_;
    Next();
  }

  raw_ptr<BrowserWindowInterface> browser_;
  const base::FilePath dir_;
  const std::vector<std::string> states_;
  size_t index_ = 0;
};

}  // namespace

void MaybeStartChromeSnapshot(BrowserWindowInterface* browser) {
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (g_started || !command_line->HasSwitch(kSnapshotSwitch)) {
    return;
  }
  g_started = true;
  const base::FilePath dir = command_line->GetSwitchValuePath(kSnapshotSwitch);
  std::string list = command_line->GetSwitchValueASCII(kStatesSwitch);
  if (list.empty()) {
    list = "default";
  }
  std::vector<std::string> states = base::SplitString(
      list, ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
  // Lives until Perch quits.
  auto* snapshotter = new Snapshotter(browser, dir, std::move(states));
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&Snapshotter::Next, base::Unretained(snapshotter)),
      base::Seconds(2));
}

}  // namespace perch
