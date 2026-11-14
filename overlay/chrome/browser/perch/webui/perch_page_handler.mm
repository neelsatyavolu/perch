// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_page_handler.h"

#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>
#import <LocalAuthentication/LocalAuthentication.h>

#include <algorithm>
#include <optional>
#include <string_view>
#include <utility>

#include "base/apple/bundle_locations.h"
#include "base/apple/foundation_util.h"
#include "base/functional/bind.h"
#include "base/strings/escape.h"
#include "base/strings/string_util.h"
#include "base/strings/sys_string_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/perch/agent/agent_tabs.h"
#include "components/tabs/public/tab_interface.h"
#include "chrome/browser/perch/agent/perch_devtools.h"
#include "chrome/browser/perch/command_bar/command_bar.h"
#include "chrome/browser/perch/onboarding/onboarding.h"
#include "chrome/browser/perch/extensions/perch_component_extensions.h"
#include "base/files/file_path.h"
#include "chrome/browser/perch/keys/key_broker.h"
#include "chrome/browser/perch/keys/recovery_key.h"
#include "chrome/browser/perch/keys/restore_flow.h"
#include "chrome/browser/perch/perch_update_policy.h"
#include "chrome/browser/perch/perch_updater_mac.h"
#include "chrome/browser/perch/settings/site_data.h"
#include "chrome/browser/perch/webui/perch_file_chooser.h"
#include "base/i18n/time_formatting.h"
#include "base/task/sequenced_task_runner.h"
#include "chrome/browser/perch/memory_saver/memory_saver_settings.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/settings/appearance.h"
#include "chrome/browser/perch/settings/privacy.h"
#include "base/base64.h"
#include "components/prefs/scoped_user_pref_update.h"
#include "base/memory/ref_counted_memory.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/profiles/profile_attributes_entry.h"
#include "chrome/browser/profiles/profile_attributes_storage.h"
#include "chrome/browser/profiles/profile_avatar_icon_util.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "ui/base/resource/resource_bundle.h"
#include "ui/gfx/image/image.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/webui/webui_embedding_context.h"
#include "chrome/browser/search_engines/template_url_service_factory.h"
#include "components/search_engines/search_engine_type.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_service.h"
#include "components/prefs/pref_service.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"
#include "url/origin.h"
#include "third_party/blink/public/common/web_preferences/web_preferences.h"

namespace perch {

namespace {

constexpr std::string_view kPages[] = {"newtab", "settings", "memory", "routines",
                                       "import", "welcome",  "tour"};

const char* const kAppearancePrefs[] = {
    prefs::kAppearanceTheme,       prefs::kAppearanceAccent,
    prefs::kAppearanceMatchSystem, prefs::kAppearanceDarkTheme,
    prefs::kAppearanceHideChrome,  prefs::kAppearanceRevealOnHover,
    prefs::kAppearanceDensity,
};

// Perch's version from the app's Info.plist (set when packaged), else
// Chromium's.
std::string PerchVersion() {
  NSString* version = base::apple::ObjCCast<NSString>(
      [base::apple::OuterBundle()
          objectForInfoDictionaryKey:@"CFBundleShortVersionString"]);
  return version ? base::SysNSStringToUTF8(version)
                 : std::string(version_info::GetVersionNumber());
}

base::DictValue About() {
  base::DictValue about;
  const std::string version = PerchVersion();
  about.Set("version", version);
  about.Set("chromium", std::string(version_info::GetVersionNumber()));
  about.Set("perchd", version);
  about.Set("channel", ReadUpdatePolicy().channel == "beta" ? "beta" : "stable");
  const UpdaterInfo updates = GetUpdaterInfo();
  about.Set("autoUpdate", updates.auto_update);
  if (updates.last_checked) {
    about.Set("lastChecked",
              base::TimeFormatAsIso8601(*updates.last_checked));
  }
  if (updates.ready_version) {
    about.Set("updateReady", *updates.ready_version);
  }
  return about;
}

// The results page for `text` on Brave or Google, from the profile's engines.
std::optional<GURL> SearchURL(Profile* profile,
                              const std::string& engine,
                              const std::string& text) {
  TemplateURLService* urls = TemplateURLServiceFactory::GetForProfile(profile);
  if (!urls) {
    return std::nullopt;
  }
  const SearchEngineType wanted =
      engine == "google" ? SEARCH_ENGINE_GOOGLE : SEARCH_ENGINE_BRAVE;
  const TemplateURL* chosen = nullptr;
  for (const TemplateURL* url : urls->GetTemplateURLs()) {
    if (url->GetEngineType(urls->search_terms_data()) == wanted) {
      chosen = url;
      break;
    }
  }
  if (!chosen) {
    chosen = urls->GetDefaultSearchProvider();
  }
  if (!chosen) {
    return std::nullopt;
  }
  const GURL result(chosen->url_ref().ReplaceSearchTerms(
      TemplateURLRef::SearchTermsArgs(base::UTF8ToUTF16(text)),
      urls->search_terms_data()));
  return result.is_valid() ? std::optional<GURL>(result) : std::nullopt;
}

base::ListValue BuiltIns(Profile* profile) {
  base::ListValue list;
  for (const BuiltInExtensionState& state : ListBuiltInExtensions(profile)) {
    list.Append(base::DictValue()
                    .Set("name", state.name)
                    .Set("enabled", state.enabled));
  }
  return list;
}

}  // namespace

PerchPageHandler::PerchPageHandler() = default;
PerchPageHandler::~PerchPageHandler() = default;

void PerchPageHandler::Navigate(const GURL& url, bool typed) {
  web_ui()->GetWebContents()->OpenURL(
      content::OpenURLParams(
          url, content::Referrer(), WindowOpenDisposition::kCurrentTab,
          typed ? ui::PageTransitionFromInt(ui::PAGE_TRANSITION_TYPED |
                                            ui::PAGE_TRANSITION_FROM_ADDRESS_BAR)
                : ui::PAGE_TRANSITION_LINK,
          false),
      {});
}

ProfileAttributesEntry* PerchPageHandler::ProfileEntry() {
  ProfileManager* manager = g_browser_process->profile_manager();
  return manager ? manager->GetProfileAttributesStorage()
                       .GetProfileAttributesWithPath(
                           profile()->GetOriginalProfile()->GetPath())
                 : nullptr;
}

Profile* PerchPageHandler::profile() {
  return Profile::FromWebUI(web_ui());
}

void PerchPageHandler::RegisterMessages() {
  web_ui()->RegisterMessageCallback(
      "perch.call", base::BindRepeating(&PerchPageHandler::HandleCall,
                                        base::Unretained(this)));
}

void PerchPageHandler::OnJavascriptAllowed() {
  appearance_registrar_.Init(profile()->GetPrefs());
  for (const char* pref : kAppearancePrefs) {
    appearance_registrar_.Add(
        pref, base::BindRepeating(&PerchPageHandler::OnAppearanceChanged,
                                  base::Unretained(this)));
  }
}

void PerchPageHandler::OnJavascriptDisallowed() {
  appearance_registrar_.RemoveAll();
  weak_factory_.InvalidateWeakPtrs();
}

void PerchPageHandler::OnAppearanceChanged() {
  FireWebUIListener("perch-event", base::Value("appearance"),
                    base::Value(GetAppearance(*profile()->GetPrefs())));
}

void PerchPageHandler::HandleCall(const base::ListValue& args) {
  AllowJavascript();
  if (args.size() != 3 || !args[1].is_string() || !args[2].is_list()) {
    if (!args.empty()) {
      Reject(args[0].Clone(), "bad-request", "Perch couldn't read that call");
    }
    return;
  }
  // The welcome page opens with a soft chime, before any click. Its first
  // call arrives once the page is in, when the setting sticks.
  content::WebContents* contents = web_ui()->GetWebContents();
  if (!sound_allowed_ && IsWelcomeURL(contents->GetLastCommittedURL())) {
    sound_allowed_ = true;
    blink::web_pref::WebPreferences prefs =
        contents->GetOrCreateWebPreferences();
    prefs.autoplay_policy =
        blink::mojom::AutoplayPolicy::kNoUserGestureRequired;
    contents->SetWebPreferences(prefs);
  }
  Dispatch(args[1].GetString(), args[2].GetList(), args[0].Clone());
}

void PerchPageHandler::Resolve(base::Value callback_id, base::Value result) {
  if (IsJavascriptAllowed()) {
    ResolveJavascriptCallback(callback_id, result);
  }
}

void PerchPageHandler::Reject(base::Value callback_id,
                              std::string code,
                              std::string message) {
  if (IsJavascriptAllowed()) {
    RejectJavascriptCallback(
        callback_id,
        base::Value(base::DictValue()
                        .Set("code", std::move(code))
                        .Set("message", std::move(message))));
  }
}

namespace {

}  // namespace

void PerchPageHandler::RevealRecoveryKey(base::Value id) {
  if (!KeyBroker::Get().RootKeyFor(profile()->GetPath())) {
    Reject(std::move(id), "unavailable",
           "This build of Perch can't show the recovery key");
    return;
  }
  // Touch ID, or the Mac's password, before the key is shown.
  LAContext* context = [[LAContext alloc] init];
  scoped_refptr<base::SequencedTaskRunner> runner =
      base::SequencedTaskRunner::GetCurrentDefault();
  base::WeakPtr<PerchPageHandler> self = weak_factory_.GetWeakPtr();
  __block base::Value callback_id = std::move(id);
  [context evaluatePolicy:LAPolicyDeviceOwnerAuthentication
          localizedReason:@"show your Perch recovery key"
                    reply:^(BOOL success, NSError* error) {
                      runner->PostTask(
                          FROM_HERE,
                          base::BindOnce(
                              [](base::WeakPtr<PerchPageHandler> self,
                                 base::Value id, bool success) {
                                if (!self) {
                                  return;
                                }
                                std::optional<std::vector<uint8_t>> key =
                                    KeyBroker::Get().RootKeyFor(
                                        self->profile()->GetPath());
                                if (!success || !key) {
                                  self->Reject(std::move(id), "cancelled",
                                               "The recovery key stays hidden");
                                  return;
                                }
                                self->Resolve(std::move(id),
                                              base::Value(FormatRecoveryKey(*key)));
                              },
                              self, std::move(callback_id), success == YES));
                    }];
}

namespace {

const char* RestoreMessage(const std::string& code) {
  return code == "wrong-key"    ? "That recovery key doesn't open this data"
         : code == "bad-backup" ? "That file isn't a Perch backup, or it's damaged"
         : code == "replaces-data"
             ? "That backup replaces Perch data made with a different key"
         : code == "busy" ? "Perch is already backing up or restoring"
         : code == "unavailable"
             ? "This build of Perch has no key helper, so it can't do that"
             : "Perch couldn't finish";
}

}  // namespace

bool PerchPageHandler::IsKeyPage() {
  // Only Settings and the welcome page may see or replace keys, not every page
  // this handler serves. The frame's origin is the WebUI's own, whatever the
  // address bar shows (perch://settings).
  content::RenderFrameHost* frame = web_ui()->GetRenderFrameHost();
  if (!frame) {
    return false;
  }
  const url::Origin origin = frame->GetLastCommittedOrigin();
  return origin.scheme() == "chrome" &&
         (origin.host() == "perch-settings" || origin.host() == "perch-welcome");
}

void PerchPageHandler::ExportBackup(base::Value id) {
  std::optional<std::vector<uint8_t>> key =
      KeyBroker::Get().RootKeyFor(profile()->GetPath());
  if (!key) {
    Reject(std::move(id), "unavailable", RestoreMessage("unavailable"));
    return;
  }
  ChooseSavePath(
      web_ui()->GetWebContents(), base::FilePath("Perch backup.perchbackup"),
      "perchbackup",
      base::BindOnce(
          [](base::WeakPtr<PerchPageHandler> self, base::Value id,
             base::FilePath profile_dir, std::vector<uint8_t> key,
             std::optional<base::FilePath> path) {
            if (!self) {
              return;
            }
            if (!path) {
              self->Resolve(std::move(id),
                            base::Value(base::DictValue().Set("saved", false)));
              return;
            }
            const std::string name = path->BaseName().AsUTF8Unsafe();
            RunExport(
                profile_dir, std::move(key), *path,
                base::BindOnce(
                    [](base::WeakPtr<PerchPageHandler> self, base::Value id,
                       std::string name, std::optional<std::string> error) {
                      if (!self) {
                        return;
                      }
                      if (error) {
                        self->Reject(std::move(id), *error,
                                     RestoreMessage(*error));
                        return;
                      }
                      self->Resolve(std::move(id),
                                    base::Value(base::DictValue()
                                                    .Set("saved", true)
                                                    .Set("name", name)));
                    },
                    self, std::move(id), name));
          },
          weak_factory_.GetWeakPtr(), std::move(id), profile()->GetPath(),
          std::move(*key)));
}

void PerchPageHandler::RestoreFromRecoveryKey(base::Value id,
                                              const base::Value* params) {
  const base::DictValue* dict = params ? params->GetIfDict() : nullptr;
  const std::string* text = dict ? dict->FindString("recoveryKey") : nullptr;
  std::optional<std::vector<uint8_t>> key =
      text ? ParseRecoveryKey(*text) : std::nullopt;
  if (!key) {
    Reject(std::move(id), "wrong-key", RestoreMessage("wrong-key"));
    return;
  }
  RestoreRequest request;
  request.profile_dir = profile()->GetPath();
  request.key = std::move(*key);
  request.replace_data = dict->FindBool("replaceData").value_or(false);
  auto reply = base::BindOnce(
      [](base::WeakPtr<PerchPageHandler> self, base::Value id,
         std::optional<std::string> error) {
        if (!self) {
          return;
        }
        if (error) {
          self->Reject(std::move(id), *error, RestoreMessage(*error));
          return;
        }
        self->Resolve(std::move(id),
                      base::Value(base::DictValue().Set("restored", true)));
      },
      weak_factory_.GetWeakPtr(), id.Clone());
  if (!dict->FindBool("fromBackup").value_or(false)) {
    RunRestore(std::move(request), std::move(reply));
    return;
  }
  ChooseOpenPath(
      web_ui()->GetWebContents(), "perchbackup",
      base::BindOnce(
          [](base::WeakPtr<PerchPageHandler> self, base::Value id,
             RestoreRequest request,
             base::OnceCallback<void(std::optional<std::string>)> reply,
             std::optional<base::FilePath> path) {
            if (!self) {
              return;
            }
            if (!path) {
              self->Resolve(std::move(id), base::Value(base::DictValue().Set(
                                               "restored", false)));
              return;
            }
            request.backup = *path;
            RunRestore(std::move(request), std::move(reply));
          },
          weak_factory_.GetWeakPtr(), std::move(id), std::move(request),
          std::move(reply)));
}

void PerchPageHandler::Dispatch(const std::string& method,
                                const base::ListValue& args,
                                base::Value id) {
  PrefService* prefs = profile()->GetPrefs();
  const base::Value* arg0 = args.empty() ? nullptr : &args[0];
  auto privacy_reply = base::BindOnce(
      [](base::WeakPtr<PerchPageHandler> self, base::Value id,
         PrivacyResult result) {
        if (!self) {
          return;
        }
        if (result.has_value()) {
          self->Resolve(std::move(id), base::Value(std::move(*result)));
        } else {
          self->Reject(std::move(id), "invalid", result.error());
        }
      },
      weak_factory_.GetWeakPtr(), id.Clone());

  if (method == "getAppearance") {
    Resolve(std::move(id), base::Value(GetAppearance(*prefs)));
  } else if (method == "setAppearance") {
    if (!arg0 || !arg0->is_dict()) {
      Reject(std::move(id), "invalid", "Send the settings to change");
      return;
    }
    if (std::optional<std::string> error =
            SetAppearance(*prefs, arg0->GetDict())) {
      Reject(std::move(id), "invalid", *error);
      return;
    }
    Resolve(std::move(id), base::Value(GetAppearance(*prefs)));
  } else if (method == "getPrivacy") {
    GetPrivacy(profile(), std::move(privacy_reply));
  } else if (method == "setPrivacy") {
    if (!arg0 || !arg0->is_dict()) {
      Reject(std::move(id), "invalid", "Send the settings to change");
      return;
    }
    SetPrivacy(profile(), arg0->GetDict(), std::move(privacy_reply));
  } else if (method == "setBackgroundConnection") {
    const std::string* connection = arg0 ? arg0->GetIfString() : nullptr;
    if (!connection || args.size() < 2 || !args[1].is_bool()) {
      Reject(std::move(id), "invalid", "Send the connection and on or off");
      return;
    }
    SetBackgroundConnection(profile(), *connection, args[1].GetBool(),
                            std::move(privacy_reply));
  } else if (method == "removeBlockerException") {
    if (!arg0 || !arg0->is_string()) {
      Reject(std::move(id), "invalid", "Send the site's host");
      return;
    }
    RemoveBlockerException(profile(), arg0->GetString(),
                           std::move(privacy_reply));
  } else if (method == "forgetSite") {
    if (!arg0 || !arg0->is_string() ||
        !ForgetSite(profile(), arg0->GetString())) {
      Reject(std::move(id), "invalid", "That isn't a site Perch can clear");
      return;
    }
    Resolve(std::move(id), base::Value());
  } else if (method == "openPage") {
    const std::string* page = arg0 ? arg0->GetIfString() : nullptr;
    if (!page || std::find(std::begin(kPages), std::end(kPages), *page) ==
                     std::end(kPages)) {
      Reject(std::move(id), "invalid", "Unknown page");
      return;
    }
    // The welcome page leaves for another page only when setup is finished
    // or skipped.
    if (IsWelcomeURL(web_ui()->GetWebContents()->GetLastCommittedURL())) {
      FinishOnboarding(web_ui()->GetWebContents());
    }
    std::string url = "chrome://perch-" + *page + "/";
    if (args.size() > 1 && args[1].is_string() && !args[1].GetString().empty()) {
      url += "#" + args[1].GetString();
    }
    Navigate(GURL(url));
    Resolve(std::move(id), base::Value());
  } else if (method == "submitQuery") {
    const base::DictValue* query = arg0 ? arg0->GetIfDict() : nullptr;
    const std::string* text = query ? query->FindString("text") : nullptr;
    const std::string* mode = query ? query->FindString("mode") : nullptr;
    const std::string* engine = query ? query->FindString("engine") : nullptr;
    if (!text || !mode || !engine ||
        base::TrimWhitespaceASCII(*text, base::TRIM_ALL).empty()) {
      Reject(std::move(id), "invalid", "Type something to search or ask");
      return;
    }
    std::optional<GURL> target;
    // With perchd running, Ask starts the task there; it opens the chat.
    if (*mode == "ask" && IsPerchdConnected()) {
      EmitPerchEvent(
          "askRequested",
          base::DictValue()
              .Set("text", *text)
              .Set("tabId", content::DevToolsAgentHost::GetOrCreateFor(
                                web_ui()->GetWebContents())
                                ->GetId()));
      Resolve(std::move(id), base::Value());
      return;
    }
    if (*mode == "ask") {
      target = GURL("chrome://perch-chat/?ask=" +
                    base::EscapeQueryParamValue(*text, /*use_plus=*/false));
    } else if (*mode == "search") {
      // As in the address bar: a site Perch recognises opens; anything else
      // is searched, with Brave or (after Tab) Google.
      if (!autocomplete_) {
        autocomplete_ = std::make_unique<PerchAutocomplete>(profile());
      }
      std::optional<PerchAutocomplete::Target> where =
          *engine == "google" ? std::nullopt
                              : autocomplete_->Destination(*text);
      if (where && !where->search) {
        Navigate(where->url, /*typed=*/true);
        Resolve(std::move(id), base::Value());
        return;
      }
      target = SearchURL(profile(), *engine, *text);
    }
    if (!target) {
      Reject(std::move(id), "invalid", "Perch couldn't run that search");
      return;
    }
    Navigate(*target);
    Resolve(std::move(id), base::Value());
  } else if (method == "autocompleteAddress") {
    // The Search box's suggestions: the address bar's, for what is typed.
    const std::string* text = arg0 ? arg0->GetIfString() : nullptr;
    if (!text || text->size() > 2000) {
      Reject(std::move(id), "invalid", "Send the text to complete");
      return;
    }
    if (!autocomplete_) {
      autocomplete_ = std::make_unique<PerchAutocomplete>(profile());
    }
    autocomplete_->Query(
        *text, base::BindOnce(
                   [](base::WeakPtr<PerchPageHandler> self, base::Value id,
                      base::DictValue result) {
                     if (self) {
                       self->Resolve(std::move(id),
                                     base::Value(std::move(result)));
                     }
                   },
                   weak_factory_.GetWeakPtr(), std::move(id)));
  } else if (method == "openAddress") {
    // A suggestion the person picked, opened as if typed in the address bar.
    const std::string* spec = arg0 ? arg0->GetIfString() : nullptr;
    const GURL url(spec ? *spec : std::string());
    if (!url.is_valid() ||
        !(url.SchemeIsHTTPOrHTTPS() || url.SchemeIs("chrome") ||
          url.IsAboutBlank())) {
      Reject(std::move(id), "invalid", "That address can't be opened here");
      return;
    }
    Navigate(url, /*typed=*/true);
    Resolve(std::move(id), base::Value());
  } else if (method == "openChat") {
    const std::string* chat = arg0 ? arg0->GetIfString() : nullptr;
    if (!chat || chat->empty() || chat->size() > 100 ||
        !std::all_of(chat->begin(), chat->end(), [](char c) {
          return base::IsAsciiAlphaNumeric(c) || c == '-' || c == '_';
        })) {
      Reject(std::move(id), "invalid", "Unknown chat");
      return;
    }
    Navigate(GURL("chrome://perch-chat/?chat=" + *chat));
    Resolve(std::move(id), base::Value());
  } else if (method == "newChat") {
    Navigate(GURL("chrome://perch-chat/"));
    Resolve(std::move(id), base::Value());
  } else if (method == "getAbout") {
    Resolve(std::move(id), base::Value(About()));
  } else if (method == "listBuiltInExtensions") {
    Resolve(std::move(id), base::Value(BuiltIns(profile())));
  } else if (method == "setBuiltInExtension") {
    const std::string* name = arg0 ? arg0->GetIfString() : nullptr;
    if (!name || args.size() < 2 || !args[1].is_bool() ||
        !SetBuiltInExtensionEnabled(profile(), *name, args[1].GetBool())) {
      Reject(std::move(id), "invalid", "Unknown built-in extension");
      return;
    }
    Resolve(std::move(id), base::Value(BuiltIns(profile())));
  } else if (method == "getMemorySaver") {
    Resolve(std::move(id), base::Value(GetMemorySaverSettings(profile())));
  } else if (method == "setMemorySaver" || method == "addSleepRule") {
    base::expected<base::DictValue, std::string> result =
        base::unexpected("Send the settings to change");
    if (method == "setMemorySaver" && arg0 && arg0->is_dict()) {
      result = SetMemorySaverSettings(profile(), arg0->GetDict());
    } else if (method == "addSleepRule" && arg0 && arg0->is_string()) {
      result = AddSleepRule(profile(), arg0->GetString());
    }
    if (!result.has_value()) {
      Reject(std::move(id), "invalid", result.error());
      return;
    }
    Resolve(std::move(id), base::Value(std::move(*result)));
  } else if (method == "queryCommandBar") {
    const std::string* text = arg0 ? arg0->GetIfString() : nullptr;
    if (!text) {
      Reject(std::move(id), "invalid", "Send the text to look for");
      return;
    }
    // The bubble opens hidden and shows once the page asks for its results.
    ShowCommandBarNow(web_ui());
    QueryCommandBar(
        profile(), *text,
        base::BindOnce(
            [](base::WeakPtr<PerchPageHandler> self, base::Value id,
               base::ListValue results) {
              if (self) {
                self->Resolve(std::move(id), base::Value(std::move(results)));
              }
            },
            weak_factory_.GetWeakPtr(), id.Clone()));
  } else if (method == "runCommandBarItem") {
    BrowserWindowInterface* browser =
        webui::GetBrowserWindowInterface(web_ui()->GetWebContents());
    if (!arg0 || !arg0->is_dict() ||
        !RunCommandBarItem(browser, arg0->GetDict())) {
      Reject(std::move(id), "invalid", "Perch couldn't open that");
      return;
    }
    Resolve(std::move(id), base::Value());
    CloseCommandBarNow(web_ui());
  } else if (method == "showAgentTab") {
    // The tour shows the agent's work: its newest tab at that address (or its
    // newest tab), moved into this window with the side chat beside it.
    const std::string* prefix = arg0 ? arg0->GetIfString() : nullptr;
    BrowserWindowInterface* browser =
        webui::GetBrowserWindowInterface(web_ui()->GetWebContents());
    std::vector<tabs::TabInterface*> agent_tabs = AgentTabsFor(profile());
    tabs::TabInterface* pick = nullptr;
    for (auto it = agent_tabs.rbegin(); it != agent_tabs.rend(); ++it) {
      const std::string url =
          (*it)->GetContents()->GetLastCommittedURL().spec();
      if (!prefix || prefix->empty() || url.starts_with(*prefix)) {
        pick = *it;
        break;
      }
    }
    if (!browser || !pick) {
      Reject(std::move(id), "not-found", "The agent has no tab open for that");
      return;
    }
    ShowAgentTab(pick, browser);
    Resolve(std::move(id), base::Value());
  } else if (method == "getProfile") {
    // Settings › Profile: this profile's name and icon, and the icons to pick
    // from (Chromium's profile pictures), each as a PNG data: URL.
    ProfileAttributesEntry* entry = ProfileEntry();
    if (!entry) {
      Reject(std::move(id), "unavailable", "This profile can't be edited");
      return;
    }
    base::ListValue icons;
    for (size_t i = profiles::GetModernAvatarIconStartIndex();
         i < profiles::GetDefaultAvatarIconCount(); ++i) {
      const gfx::Image& image =
          ui::ResourceBundle::GetSharedInstance().GetImageNamed(
              profiles::GetDefaultAvatarIconResourceIDAtIndex(i));
      scoped_refptr<base::RefCountedMemory> png = image.As1xPNGBytes();
      if (!png || png->size() == 0) {
        continue;
      }
      icons.Append(base::DictValue()
                       .Set("index", static_cast<int>(i))
                       .Set("url", "data:image/png;base64," +
                                       base::Base64Encode(*png)));
    }
    const std::string* picture =
        g_browser_process->local_state()
            ->GetDict(prefs::kProfilePictures)
            .FindString(entry->GetPath().BaseName().AsUTF8Unsafe());
    Resolve(std::move(id),
            base::Value(base::DictValue()
                            .Set("picture", picture ? base::Value(
                                                          "data:image/png;base64," +
                                                          *picture)
                                                    : base::Value())
                            .Set("name", entry->GetLocalProfileName())
                            .Set("icon", static_cast<int>(
                                             entry->GetAvatarIconIndex()))
                            .Set("icons", std::move(icons))));
  } else if (method == "setProfilePicture") {
    // A picture of the person's own (Settings › Profile): a square PNG the
    // page made from their file, or null to go back to the chosen icon.
    ProfileAttributesEntry* entry = ProfileEntry();
    if (!entry) {
      Reject(std::move(id), "unavailable", "This profile can't be edited");
      return;
    }
    const std::string key = entry->GetPath().BaseName().AsUTF8Unsafe();
    ScopedDictPrefUpdate pictures(g_browser_process->local_state(),
                                  prefs::kProfilePictures);
    const std::string* png = arg0 ? arg0->GetIfString() : nullptr;
    if (!png) {
      pictures->Remove(key);
      Resolve(std::move(id), base::Value());
      return;
    }
    std::optional<std::vector<uint8_t>> bytes =
        png->size() <= 400 * 1024 ? base::Base64Decode(*png) : std::nullopt;
    const gfx::Image image =
        bytes ? gfx::Image::CreateFrom1xPNGBytes(*bytes) : gfx::Image();
    if (image.IsEmpty() || image.Width() > 512 || image.Height() > 512) {
      Reject(std::move(id), "invalid",
             "That picture couldn't be used. Try a PNG or JPEG image");
      return;
    }
    pictures->Set(key, *png);
    Resolve(std::move(id), base::Value());
  } else if (method == "setProfile") {
    ProfileAttributesEntry* entry = ProfileEntry();
    const base::DictValue* patch = arg0 ? arg0->GetIfDict() : nullptr;
    if (!entry || !patch) {
      Reject(std::move(id), "invalid", "Nothing to change");
      return;
    }
    if (const std::string* name = patch->FindString("name")) {
      const std::u16string trimmed = base::CollapseWhitespace(
          base::UTF8ToUTF16(*name), /*trim_sequences_with_line_breaks=*/true);
      if (trimmed.empty() || trimmed.size() > 50) {
        Reject(std::move(id), "invalid", "Give the profile a name of 1 to 50 characters");
        return;
      }
      entry->SetLocalProfileName(trimmed, /*is_default_name=*/false);
    }
    if (std::optional<int> icon = patch->FindInt("icon")) {
      if (*icon < static_cast<int>(profiles::GetModernAvatarIconStartIndex()) ||
          *icon >= static_cast<int>(profiles::GetDefaultAvatarIconCount())) {
        Reject(std::move(id), "invalid", "That isn't one of the icons");
        return;
      }
      entry->SetAvatarIconIndex(static_cast<size_t>(*icon));
    }
    Resolve(std::move(id), base::Value());
  } else if (method == "finishTour") {
    // The tour was finished or skipped: it stops opening at launch.
    FinishTour(profile());
    Resolve(std::move(id), base::Value());
  } else if (method == "showThisTab") {
    // The tour comes back to front when the agent's task ends.
    tabs::TabInterface* tab =
        tabs::TabInterface::MaybeGetFromContents(web_ui()->GetWebContents());
    BrowserWindowInterface* browser =
        tab ? tab->GetBrowserWindowInterface() : nullptr;
    TabStripModel* model = browser ? browser->GetTabStripModel() : nullptr;
    const int index = model ? model->GetIndexOfTab(tab) : TabStripModel::kNoTab;
    if (index == TabStripModel::kNoTab) {
      Reject(std::move(id), "not-found", "This page isn't in a tab");
      return;
    }
    model->ActivateTabAt(index);
    Resolve(std::move(id), base::Value());
  } else if (method == "openCommandBar") {
    // The tour shows the command bar off over its own window.
    BrowserWindowInterface* browser =
        webui::GetBrowserWindowInterface(web_ui()->GetWebContents());
    if (!browser) {
      Reject(std::move(id), "unavailable", "There's no window to open it in");
      return;
    }
    ToggleCommandBar(browser);
    Resolve(std::move(id), base::Value());
  } else if (method == "closeCommandBar") {
    Resolve(std::move(id), base::Value());
    CloseCommandBarNow(web_ui());
  } else if (method == "listSiteData") {
    ListSiteData(profile(),
                 base::BindOnce(
                     [](base::WeakPtr<PerchPageHandler> self, base::Value id,
                        base::ListValue sites) {
                       if (self) {
                         self->Resolve(std::move(id),
                                       base::Value(std::move(sites)));
                       }
                     },
                     weak_factory_.GetWeakPtr(), id.Clone()));
  } else if (method == "chooseFile") {
    const std::string* kind = arg0 ? arg0->GetIfString() : nullptr;
    std::vector<std::string> extensions;
    if (kind && *kind == "passwords-csv") {
      extensions = {"csv"};
    } else if (kind && *kind == "safari-export") {
      extensions = {"zip"};
    } else if (kind && *kind == "memory-export") {
      extensions = {"zip", "json", "html"};
    } else {
      Reject(std::move(id), "invalid", "Unknown kind of file");
      return;
    }
    ChooseOneFile(web_ui()->GetWebContents(), extensions,
                  base::BindOnce(
                      [](base::WeakPtr<PerchPageHandler> self, base::Value id,
                         std::optional<base::Value> choice) {
                        if (self) {
                          self->Resolve(std::move(id),
                                        choice ? std::move(*choice)
                                               : base::Value());
                        }
                      },
                      weak_factory_.GetWeakPtr(), id.Clone()));
  } else if (method == "restartPerch") {
    // Full Disk Access applies from the next launch; Perch reopens its tabs
    // (and setup, where it was) after restarting.
    Resolve(std::move(id), base::Value());
    chrome::AttemptRestart();
  } else if (method == "openFullDiskAccess") {
    [NSWorkspace.sharedWorkspace
        openURL:[NSURL URLWithString:@"x-apple.systempreferences:com.apple."
                                     @"preference.security?Privacy_AllFiles"]];
    Resolve(std::move(id), base::Value());
  } else if (method == "installUpdate" && InstallReadyUpdate()) {
    // Perch quits and relaunches into the new version.
    Resolve(std::move(id),
            base::Value(base::DictValue().Set("state", "ready")));
  } else if (method == "checkForUpdates" || method == "installUpdate") {
    if (!CheckForUpdatesNow()) {
      Resolve(std::move(id),
              base::Value(base::DictValue()
                              .Set("state", "error")
                              .Set("message", GetUpdaterInfo().managed
                                                  ? "Updates are managed by "
                                                    "your organization"
                                                  : "This build of Perch "
                                                    "doesn't update itself")));
      return;
    }
    Resolve(std::move(id),
            base::Value(base::DictValue().Set("state", "checking")));
  } else if (method == "setAutoUpdate") {
    if (!arg0 || !arg0->is_bool() || !SetAutoUpdate(arg0->GetBool())) {
      Reject(std::move(id), "managed",
             "Perch can't change automatic updates here");
      return;
    }
    Resolve(std::move(id), base::Value(About()));
  } else if ((method == "revealRecoveryKey" || method == "exportBackup" ||
              method == "restoreFromRecoveryKey" ||
              method == "startFresh") &&
             !IsKeyPage()) {
    Reject(std::move(id), "unavailable", "Only Perch's settings can do that");
  } else if (method == "revealRecoveryKey") {
    RevealRecoveryKey(std::move(id));
  } else if (method == "getSecurity") {
    const base::FilePath dir = profile()->GetPath();
    Resolve(std::move(id),
            base::Value(
                base::DictValue()
                    .Set("available", KeyBroker::Get().HelperAvailable())
                    .Set("protected", KeyBroker::Get().IsProtected(dir))
                    .Set("needsRestore", KeyBroker::Get().NeedsRestore(dir))));
  } else if (method == "exportBackup") {
    ExportBackup(std::move(id));
  } else if (method == "startFresh") {
    RunStartFresh(
        profile()->GetPath(),
        base::BindOnce(
            [](base::WeakPtr<PerchPageHandler> self, base::Value id,
               std::optional<std::string> error) {
              if (!self) {
                return;
              }
              if (error) {
                self->Reject(std::move(id), *error, RestoreMessage(*error));
                return;
              }
              self->Resolve(std::move(id), base::Value(base::DictValue()));
            },
            weak_factory_.GetWeakPtr(), std::move(id)));
  } else if (method == "restoreFromRecoveryKey") {
    RestoreFromRecoveryKey(std::move(id), arg0);
  } else if (method == "listTabMemory") {
    Resolve(std::move(id), base::Value(ListTabMemory(profile())));
  } else {
    Reject(std::move(id), "unavailable",
           "This part of Perch isn't available in this build yet");
  }
}

}  // namespace perch
