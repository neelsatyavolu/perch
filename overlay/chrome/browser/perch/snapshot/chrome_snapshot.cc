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
#include "chrome/browser/ui/browser_commands.h"
#include "ui/shell_dialogs/selected_file_info.h"
#include "ui/shell_dialogs/select_file_policy.h"
#include "ui/shell_dialogs/select_file_dialog_factory.h"
#include "ui/shell_dialogs/select_file_dialog.h"
#include "components/keyed_service/core/service_access_type.h"
#include "components/password_manager/core/browser/password_store/password_store_interface.h"
#include "components/password_manager/core/browser/password_store/stored_credential.h"
#include "components/password_manager/core/browser/password_string.h"
#include "chrome/browser/password_manager/factories/profile_password_store_factory.h"
#include "ui/events/event.h"
#include "chrome/browser/ui/views/location_bar/location_bar_view.h"
#include "chrome/browser/ui/views/omnibox/omnibox_view_views.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/views/toolbar/toolbar_view.h"
#include "chrome/browser/ui/views/extensions/extensions_toolbar_desktop.h"
#include "chrome/browser/ui/views/extensions/extensions_toolbar_button.h"
#include "extensions/browser/extension_registry.h"
#include "components/autofill/core/browser/data_manager/addresses/address_data_manager.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "content/public/browser/render_widget_host_view.h"
#include "chrome/browser/ui/browser_tabstrip.h"
#include "chrome/browser/ui/views/side_panel/side_panel.h"
#include "chrome/browser/ui/side_panel/side_panel_enums.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_key.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_id.h"
#include "chrome/browser/ui/side_panel/side_panel_ui.h"
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

// Off-screen tests: --perch-test-pick-file=<path> answers every open or save
// panel with that path at once, so no panel ever opens on the screen.
constexpr char kTestPickFileSwitch[] = "perch-test-pick-file";

class PickedFileDialog : public ui::SelectFileDialog {
 public:
  PickedFileDialog(Listener* listener,
                   std::unique_ptr<ui::SelectFilePolicy> policy,
                   base::FilePath file)
      : ui::SelectFileDialog(listener, std::move(policy)),
        file_(std::move(file)) {}

  bool IsRunning(gfx::NativeWindow owning_window) const override {
    return false;
  }
  void ListenerDestroyed() override { listener_ = nullptr; }

 protected:
  void SelectFileImpl(Type type,
                      const std::u16string& title,
                      const base::FilePath& default_path,
                      const FileTypeInfo* file_types,
                      int file_type_index,
                      const base::FilePath::StringType& default_extension,
                      gfx::NativeWindow owning_window,
                      const GURL* caller) override {
    LOG(WARNING) << "Perch test: file panel '" << title << "' answered with "
                 << file_.value();
    if (listener_) {
      listener_->FileSelected(ui::SelectedFileInfo(file_), 0);
    }
  }
  bool HasMultipleFileTypeChoicesImpl() override { return false; }

 private:
  ~PickedFileDialog() override = default;
  base::FilePath file_;
};

class PickedFileFactory : public ui::SelectFileDialogFactory {
 public:
  explicit PickedFileFactory(base::FilePath file) : file_(std::move(file)) {}
  ui::SelectFileDialog* Create(
      ui::SelectFileDialog::Listener* listener,
      std::unique_ptr<ui::SelectFilePolicy> policy) override {
    return new PickedFileDialog(listener, std::move(policy), file_);
  }

 private:
  base::FilePath file_;
};

void MaybeInstallTestFilePicker() {
  static bool installed = false;
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (installed || !command_line->HasSwitch(kTestPickFileSwitch)) {
    return;
  }
  installed = true;
  ui::SelectFileDialog::SetFactory(std::make_unique<PickedFileFactory>(
      command_line->GetSwitchValuePath(kTestPickFileSwitch)));
}

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
    } else if (state.starts_with("open:")) {
      // A new tab at the URL after "open:", made active.
      Open(state.substr(5).c_str());
      TabStripModel* tabs = browser_->GetTabStripModel();
      tabs->ActivateTabAt(tabs->count() - 1);
    } else if (state.starts_with("select:")) {
      // Makes the tab at the index after "select:" active.
      int index = 0;
      if (base::StringToInt(state.substr(7), &index) &&
          browser_->GetTabStripModel()->ContainsIndex(index)) {
        browser_->GetTabStripModel()->ActivateTabAt(index);
      }
    } else if (state == "panel") {
      SidePanelUI::From(browser_)->Show(SidePanelEntryId::kPerch);
    } else if (state == "paint-active") {
      // Draws the window as the active one without taking focus, for looking
      // at active-only painting from a background window.
      paint_as_active_ = BrowserView::GetBrowserViewForBrowser(browser_)
                             ->GetWidget()
                             ->LockPaintAsActive();
    } else if (state == "extensions-panel") {
      // Opens Perch's extensions list from its toolbar button.
      BrowserView::GetBrowserViewForBrowser(browser_)
          ->toolbar()
          ->extensions_container_for_testing()
          ->GetExtensionsButton()
          ->ToggleExtensionsMenu();
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
                   << ListSpaces(browser_).size();
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
        SetTaskStatus("chat-2", TaskState::kWaiting, {}, std::string());
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
        "tabs":[
          {"selected":1,"groups":[],"tabs":[
            {"url":"https://example.com/a","title":"A","pinned":false},
            {"url":"https://example.com/b","title":"B","pinned":false}]},
          {"selected":0,"groups":[],"tabs":[
            {"url":"https://example.org/c","title":"C","pinned":true},
            {"url":"https://example.org/d","title":"D","pinned":false},
            {"url":"https://example.org/e","title":"E","pinned":false}]},
          {"selected":0,"groups":[],"tabs":[
            {"url":"https://example.net/f","title":"F","pinned":false}]}],
        "addresses":[{"name":"Maya Chen","organization":"","street":"1 Main St",
          "city":"Palo Alto","state":"CA","zip":"94301","country":"US",
          "phone":"","email":"maya@example.com"}],
        "extensions":[{"id":"x","name":"X","version":"1"},
          {"id":"ddkjiahejlhfcafbddmgiahcphecmpfh","name":"uBlock Origin Lite",
           "version":"1","storeUrl":"https://chromewebstore.google.com/detail/ddkjiahejlhfcafbddmgiahcphecmpfh"}]}})");
      ApplyImportBundle(
          browser_->GetProfile(),
          base::DictValue().Set("path", file.value()),
          base::BindOnce([](DataResult result) {
            LOG(WARNING) << "Perch snapshot: import "
                         << (result.has_value() ? result->DebugString()
                                                : result.error());
          }));
    } else if (state == "import-check") {
      // After "import": the windows it made, and whether the extension and
      // the address arrived.
      std::string windows;
      for (BrowserWindowInterface* window : GetAllBrowserWindowInterfaces()) {
        TabStripModel* tabs = window->GetTabStripModel();
        windows += " [" + base::NumberToString(tabs->count()) + " tabs, active " +
                   base::NumberToString(tabs->active_index()) + "]";
      }
      Profile* profile = browser_->GetProfile();
      autofill::PersonalDataManager* data =
          autofill::PersonalDataManagerFactory::GetForBrowserContext(profile);
      LOG(WARNING) << "Perch snapshot: import-check windows:" << windows
                   << " / extension installed "
                   << !!extensions::ExtensionRegistry::Get(profile)
                            ->GetInstalledExtension(
                                "ddkjiahejlhfcafbddmgiahcphecmpfh")
                   << " / addresses "
                   << (data ? data->address_data_manager().GetProfiles().size()
                            : 0);
    } else if (state == "login-open") {
      // A sign-in form on a local test server (http://127.0.0.1:8765/).
      browser_->GetTabStripModel()->GetActiveWebContents()->GetController()
          .LoadURL(GURL("http://127.0.0.1:8765/login.html"), content::Referrer(),
                   ui::PAGE_TRANSITION_TYPED, std::string());
    } else if (state == "login") {
      // A saved password for that origin.
      content::WebContents* page =
          browser_->GetTabStripModel()->GetActiveWebContents();
      password_manager::StoredCredential form;
      form.signon_realm = "http://127.0.0.1:8765/";
      form.url = GURL("http://127.0.0.1:8765/login.html");
      form.username_value = u"test@example.com";
      form.password_value =
          password_manager::PasswordString(u"not-a-real-password");
      ProfilePasswordStoreFactory::GetForProfile(
          Profile::FromBrowserContext(page->GetBrowserContext()),
          ServiceAccessType::EXPLICIT_ACCESS)
          ->AddLogin(std::move(form));
    } else if (state == "login-run") {
      content::WebContents* page =
          browser_->GetTabStripModel()->GetActiveWebContents();
      const std::string target =
          content::DevToolsAgentHost::GetOrCreateFor(page)->GetId();
      ListLogins(
          base::DictValue().Set("targetId", target),
          base::BindOnce(
              [](std::string target, base::WeakPtr<content::WebContents> page,
                 DataResult logins) {
                LOG(WARNING) << "Perch snapshot: logins "
                             << (logins.has_value() ? logins->DebugString()
                                                    : logins.error());
                const base::ListValue* list =
                    logins.has_value() ? logins->FindList("logins") : nullptr;
                const std::string* id =
                    list && !list->empty()
                        ? (*list)[0].GetDict().FindString("loginId")
                        : nullptr;
                if (!id) {
                  return;
                }
                FillLogin(
                    base::DictValue().Set("targetId", target).Set("loginId", *id),
                    base::BindOnce(
                        [](base::WeakPtr<content::WebContents> page,
                           DataResult result) {
                          LOG(WARNING) << "Perch snapshot: login fill "
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
                                      LOG(WARNING)
                                          << "Perch snapshot: login fields "
                                          << v.DebugString();
                                    }),
                                    content::ISOLATED_WORLD_ID_GLOBAL);
                          }
                        },
                        page));
              },
              target, page->GetWeakPtr()));
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
      // Both toolbar menus' items, then New Tab run from the menu button's.
      auto labels = [](ui::MenuModel& menu) {
        std::string items;
        for (size_t i = 0; i < menu.GetItemCount(); ++i) {
          items += menu.GetTypeAt(i) == ui::MenuModel::TYPE_SEPARATOR
                       ? std::string(" |")
                       : " " + base::UTF16ToUTF8(menu.GetLabelAt(i));
        }
        return items;
      };
      PerchProfileMenuModel profiles(browser_,
                                     PerchProfileMenuModel::Kind::kProfile);
      PerchProfileMenuModel app(browser_, PerchProfileMenuModel::Kind::kApp);
      const int before = browser_->GetTabStripModel()->count();
      app.ExecuteCommand(IDC_NEW_TAB, 0);
      LOG(WARNING) << "Perch snapshot: profile menu:" << labels(profiles)
                   << " / app menu:" << labels(app) << " / tabs " << before
                   << " -> " << browser_->GetTabStripModel()->count();
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
    } else if (state == "omnibox-type") {
      // Types into the focused address bar so its suggestions open (pair
      // with "pause" to inspect the popup over CDP).
      LocationBarView* bar = BrowserView::GetBrowserViewForBrowser(browser_)
                                 ->GetLocationBarView();
      bar->FocusLocation(/*is_user_initiated=*/true,
                         /*clear_focus_if_failed=*/false);
      bar->omnibox_view()->SetUserText(u"hello");
    } else if (state == "omnibox-ask") {
      // ⌘↵ in the address bar asks Perch's agent (Perch.askRequested).
      OmniboxViewViews* omnibox = BrowserView::GetBrowserViewForBrowser(browser_)
                                      ->GetLocationBarView()
                                      ->omnibox_view();
      omnibox->SetUserText(u"summarize this page");
      const ui::KeyEvent key(ui::EventType::kKeyPressed, ui::VKEY_RETURN,
                             ui::EF_COMMAND_DOWN);
      // The controller interface is how Textfield delivers keys to it.
      views::TextfieldController* controller = omnibox;
      const bool handled = controller->HandleKeyEvent(omnibox, key);
      LOG(WARNING) << "Perch snapshot: omnibox ask handled " << handled
                   << ", text left '" << omnibox->GetText() << "'";
    } else if (state == "sidebar-newtab") {
      // The sidebar stays open across a new tab, and comes back without a
      // reload after a close on another tab (see perch_side_panel_controller).
      SidePanelUI::From(browser_)->Show(SidePanelEntryId::kPerch);
      base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
          FROM_HERE,
          base::BindOnce(&Snapshotter::CheckSidebarNewTab,
                         base::Unretained(this)),
          base::Milliseconds(1500));
    } else if (state == "split") {
      // A side-by-side split, then ⌃⌘[ to focus its left side.
      chrome::ExecuteCommand(browser_, IDC_NEW_SPLIT_TAB);
      ExecutePerchCommand(browser_, IDC_PERCH_SPLIT_FOCUS_LEFT);
      LOG(WARNING) << "Perch snapshot: split active index "
                   << browser_->GetTabStripModel()->active_index();
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

  std::unique_ptr<views::Widget::PaintAsActiveLock> paint_as_active_;

  views::View* SidebarContent() {
    SidePanel* panel =
        BrowserView::GetBrowserViewForBrowser(browser_)->side_panel();
    views::View* parent = panel ? panel->GetContentParentView() : nullptr;
    return parent && !parent->children().empty() ? parent->children().front()
                                                 : nullptr;
  }

  bool SidebarShowing() {
    SidePanelUI* ui = SidePanelUI::From(browser_);
    return ui && ui->IsSidePanelEntryShowing(
                     SidePanelEntryKey(SidePanelEntryId::kPerch));
  }

  void CheckSidebarNewTab() {
    TabStripModel* tabs = browser_->GetTabStripModel();
    views::View* first = SidebarContent();
    const bool open_before = SidebarShowing();
    chrome::ExecuteCommand(browser_, IDC_NEW_TAB);
    const bool open_after_new_tab = SidebarShowing();
    const bool same_after_new_tab = SidebarContent() == first;
    // Close it on the new tab, go back (open there), then return (closed).
    SidePanelUI::From(browser_)->Close(
        SidePanelEntryHideReason::kSidePanelClosed,
        /*suppress_animations=*/true);
    const int new_tab = tabs->active_index();
    tabs->ActivateTabAt(0);
    const bool reopened = SidebarShowing();
    const bool same_after_reopen = SidebarContent() == first;
    tabs->ActivateTabAt(new_tab);
    const bool closed_again = !SidebarShowing();
    tabs->ActivateTabAt(0);
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(
            [](Snapshotter* self, bool a, bool b, bool c, bool d, bool e,
               bool f) {
              content::WebContents* page =
                  self->browser_->GetTabStripModel()->GetActiveWebContents();
              LOG(WARNING) << "Perch snapshot: sidebar-newtab open " << a
                           << " / after new tab open " << b << " same view "
                           << c << " / back to first reopened " << d
                           << " same view " << e << " / new tab closed "
                           << f << " / page focused "
                           << (page && page->GetRenderWidgetHostView() &&
                               page->GetRenderWidgetHostView()->HasFocus());
            },
            base::Unretained(this), open_before, open_after_new_tab,
            same_after_new_tab, reopened, same_after_reopen, closed_again),
        base::Milliseconds(300));
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
  MaybeInstallTestFilePicker();
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
