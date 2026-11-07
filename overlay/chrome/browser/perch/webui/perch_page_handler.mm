// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/webui/perch_page_handler.h"

#import <Foundation/Foundation.h>

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
#include "chrome/browser/perch/extensions/perch_component_extensions.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/settings/appearance.h"
#include "chrome/browser/perch/settings/privacy.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/search_engines/template_url_service_factory.h"
#include "components/search_engines/search_engine_type.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_service.h"
#include "components/prefs/pref_service.h"
#include "components/version_info/version_info.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/web_ui.h"
#include "ui/base/page_transition_types.h"
#include "ui/base/window_open_disposition.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr std::string_view kPages[] = {"newtab",   "settings", "memory",
                                       "routines", "import",   "welcome"};

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
  about.Set("channel", "stable");
  about.Set("autoUpdate", true);
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

void PerchPageHandler::Navigate(const GURL& url) {
  web_ui()->GetWebContents()->OpenURL(
      content::OpenURLParams(url, content::Referrer(),
                             WindowOpenDisposition::kCurrentTab,
                             ui::PAGE_TRANSITION_LINK, false),
      {});
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
    if (*mode == "ask") {
      target = GURL("chrome://perch-chat/?ask=" +
                    base::EscapeQueryParamValue(*text, /*use_plus=*/false));
    } else if (*mode == "search") {
      target = SearchURL(profile(), *engine, *text);
    }
    if (!target) {
      Reject(std::move(id), "invalid", "Perch couldn't run that search");
      return;
    }
    Navigate(*target);
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
  } else {
    Reject(std::move(id), "unavailable",
           "This part of Perch isn't available in this build yet");
  }
}

}  // namespace perch
