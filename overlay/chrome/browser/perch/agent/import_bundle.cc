// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/import_bundle.h"

#include <memory>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/path_service.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/functional/callback_helpers.h"
#include "chrome/browser/autofill/personal_data_manager_factory.h"
#include "chrome/browser/bookmarks/bookmark_model_factory.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "components/prefs/pref_service.h"
#include "components/bookmarks/browser/bookmark_model.h"
#include "chrome/browser/profiles/profile_attributes_entry.h"
#include "chrome/browser/profiles/profile_attributes_storage.h"
#include "chrome/browser/profiles/profile_manager.h"
#include "content/public/browser/storage_partition.h"
#include "net/cookies/canonical_cookie.h"
#include "net/cookies/cookie_constants.h"
#include "net/cookies/cookie_inclusion_status.h"
#include "net/cookies/cookie_options.h"
#include "net/cookies/cookie_partition_key.h"
#include "services/network/public/mojom/cookie_manager.mojom.h"
#include "chrome/browser/extensions/webstore_install_with_prompt.h"
#include "chrome/browser/importer/profile_writer.h"
#include "chrome/browser/perch/spaces/spaces.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/toolbar/toolbar_actions_model.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/browser_window/public/create_browser_window.h"
#include "chrome/common/chrome_paths.h"
#include "components/autofill/core/browser/data_manager/addresses/address_data_manager.h"
#include "components/autofill/core/browser/data_manager/personal_data_manager.h"
#include "components/autofill/core/browser/data_model/addresses/autofill_profile.h"
#include "components/autofill/core/browser/field_types.h"
#include "components/autofill/core/browser/geo/country_data.h"
#include "components/crx_file/id_util.h"
#include "components/history/core/browser/history_types.h"
#include "components/history/core/browser/url_row.h"
#include "components/password_manager/core/browser/password_form.h"
#include "components/password_manager/core/browser/password_string.h"
#include "components/search_engines/template_url.h"
#include "components/search_engines/template_url_data.h"
#include "components/user_data_importer/common/imported_bookmark_entry.h"
#include "extensions/browser/extension_registry.h"
#include "ui/base/base_window.h"
#include "ui/gfx/native_ui_types.h"
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
  for (const auto [name, in_toolbar] :
       {std::pair("bar", true), std::pair("other", false),
        std::pair("mobile", false)}) {
    // ProfileWriter takes a toolbar entry's first path part to be the source
    // browser's name for its bookmarks bar and drops it, so one is given;
    // without it each top-level folder was dropped and its bookmarks spilled
    // onto the bar.
    std::vector<std::u16string> path;
    if (in_toolbar) {
      path.push_back(u"Bookmarks Bar");
    }
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

// The windows come over as windows. The first joins the window you are in,
// asleep, so the tab you are on stays where it is; each of the others gets a
// window of its own, with the tab that was selected there loaded.
int ApplyTabs(Profile* profile, const base::ListValue& windows) {
  BrowserWindowInterface* current =
      GetLastActiveBrowserWindowInterfaceWithAnyProfile();
  if (current && current->GetProfile() != profile) {
    current = nullptr;
  }
  int count = 0;
  bool first = true;
  for (const base::Value& item : windows) {
    const base::DictValue* window = item.GetIfDict();
    const base::ListValue* list = window ? window->FindList("tabs") : nullptr;
    const int selected =
        window ? window->FindInt("selected").value_or(0) : 0;
    const bool into_current = first && current;
    std::vector<SpaceTab> tabs;
    for (size_t i = 0; list && i < list->size(); ++i) {
      const base::DictValue* tab = (*list)[i].GetIfDict();
      const std::string* url = tab ? tab->FindString("url") : nullptr;
      if (!url || !GURL(*url).is_valid()) {
        continue;
      }
      const std::string* title = tab->FindString("title");
      tabs.push_back({GURL(*url), title ? base::UTF8ToUTF16(*title) : u"",
                      tab->FindBool("pinned").value_or(false),
                      !into_current && static_cast<int>(i) == selected});
    }
    if (tabs.empty()) {
      continue;
    }
    first = false;
    if (into_current) {
      AppendTabsAsleep(current, tabs);
    } else {
      BrowserWindowInterface* created = CreateBrowserWindow(
          BrowserWindowCreateParams(profile, /*from_user_gesture=*/false));
      if (!created) {
        continue;
      }
      OpenTabsAsleep(created, tabs);
      created->GetWindow()->ShowInactive();
    }
    count += static_cast<int>(tabs.size());
  }
  return count;
}

// Sign-ins (cookies) for a profile perchd can't reach over the DevTools pipe:
// one imported into a Perch profile of its own. Each goes straight into that
// profile's cookie store; one that isn't a valid cookie is left out.
int ApplyCookies(Profile* profile, const base::ListValue& cookies) {
  network::mojom::CookieManager* manager =
      profile->GetDefaultStoragePartition()
          ->GetCookieManagerForBrowserProcess();
  if (!manager) {
    return 0;
  }
  int count = 0;
  for (const base::Value& item : cookies) {
    const base::DictValue* c = item.GetIfDict();
    const std::string* name = c ? c->FindString("name") : nullptr;
    const std::string* value = c ? c->FindString("value") : nullptr;
    const std::string* domain = c ? c->FindString("domain") : nullptr;
    if (!name || !value || !domain || domain->empty()) {
      continue;
    }
    const std::string* path_value = c->FindString("path");
    const std::string path =
        path_value && !path_value->empty() ? *path_value : "/";
    const bool secure = c->FindBool("secure").value_or(false);
    const bool http_only = c->FindBool("httpOnly").value_or(false);
    // ".example.com" is for the domain and its subdomains; "example.com" for
    // that host only, which a cookie gets by naming no domain.
    const bool domain_wide = domain->starts_with(".");
    const std::string host = domain_wide ? domain->substr(1) : *domain;
    const GURL url((secure ? "https://" : "http://") + host + path);
    if (!url.is_valid()) {
      continue;
    }
    net::CookieSameSite same_site = net::CookieSameSite::UNSPECIFIED;
    if (const std::string* mode = c->FindString("sameSite")) {
      if (*mode == "Strict") {
        same_site = net::CookieSameSite::STRICT_MODE;
      } else if (*mode == "Lax") {
        same_site = net::CookieSameSite::LAX_MODE;
      } else if (*mode == "None" && secure) {
        same_site = net::CookieSameSite::NO_RESTRICTION;
      }
    }
    std::optional<net::CookiePartitionKey> partition;
    if (const base::DictValue* p = c->FindDict("partition")) {
      const std::string* site = p->FindString("site");
      if (!site) {
        continue;
      }
      auto key = net::CookiePartitionKey::FromUntrustedInput(
          *site, p->FindBool("crossSite").value_or(false));
      if (!key.has_value()) {
        continue;
      }
      partition = *key;
    }
    const std::optional<double> expires = c->FindDouble("expires");
    const base::Time now = base::Time::Now();
    net::CookieInclusionStatus status;
    std::unique_ptr<net::CanonicalCookie> cookie =
        net::CanonicalCookie::CreateSanitizedCookie(
            url, *name, *value, domain_wide ? *domain : "", path, now,
            expires ? base::Time::FromSecondsSinceUnixEpoch(*expires)
                    : base::Time(),
            now, secure, http_only, same_site, net::COOKIE_PRIORITY_DEFAULT,
            partition, &status);
    if (!cookie) {
      continue;
    }
    manager->SetCanonicalCookie(*cookie, url,
                                net::CookieOptions::MakeAllInclusive(),
                                base::DoNothing());
    ++count;
  }
  return count;
}

// Pins or unpins a newly installed extension. The toolbar learns of it a
// moment after the install reports success, so this waits for that.
void ApplyPin(base::WeakPtr<Profile> profile,
              const std::string& id,
              bool pinned,
              int tries_left) {
  ToolbarActionsModel* toolbar =
      profile ? ToolbarActionsModel::Get(profile.get()) : nullptr;
  if (!toolbar) {
    return;
  }
  if (toolbar->HasAction(id)) {
    // Setting the state it already has is an error to the model.
    if (toolbar->IsActionPinned(id) != pinned) {
      toolbar->SetActionVisibility(id, pinned);
    }
    return;
  }
  if (tries_left > 0) {
    base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&ApplyPin, std::move(profile), id, pinned,
                       tries_left - 1),
        base::Milliseconds(500));
  }
}

// Installs from the Chrome Web Store without asking again: the person ticked
// Extensions in the import, and had each of these installed already.
class ImportedExtensionInstaller : public extensions::WebstoreInstallWithPrompt {
 public:
  using WebstoreInstallWithPrompt::WebstoreInstallWithPrompt;

 private:
  ~ImportedExtensionInstaller() override = default;

  std::unique_ptr<extensions::InstallPromptData> CreateInstallPrompt()
      const override {
    return nullptr;
  }
  bool ShouldShowPostInstallUI() const override { return false; }
};

// Starts the installs and returns how many; each finishes on its own.
int ApplyExtensions(Profile* profile, const base::ListValue& list) {
  extensions::ExtensionRegistry* registry =
      extensions::ExtensionRegistry::Get(profile);
  int started = 0;
  for (const base::Value& item : list) {
    const base::DictValue* entry = item.GetIfDict();
    const std::string* id = entry ? entry->FindString("id") : nullptr;
    // Only extensions with a store page can be fetched again.
    if (!id || !entry->FindString("storeUrl") ||
        !crx_file::id_util::IdIsValid(*id) ||
        registry->GetInstalledExtension(*id)) {
      continue;
    }
    // Pinned to the toolbar or not, as it was in the browser it came from.
    const std::optional<bool> pinned = entry->FindBool("pinned");
    base::MakeRefCounted<ImportedExtensionInstaller>(
        *id, profile, gfx::NativeWindow(),
        base::BindOnce(
            [](base::WeakPtr<Profile> profile, const std::string& id,
               std::optional<bool> pinned, bool success,
               const std::string& error,
               extensions::webstore_install::Result) {
              if (!success) {
                LOG(WARNING) << "Perch import: extension " << id
                             << " not installed: " << error;
                return;
              }
              if (pinned) {
                ApplyPin(std::move(profile), id, *pinned, /*tries_left=*/8);
              }
            },
            profile->GetWeakPtr(), *id, pinned))
        ->BeginInstall();
    ++started;
  }
  return started;
}

int ApplyAddresses(Profile* profile, const base::ListValue& list) {
  autofill::PersonalDataManager* data =
      autofill::PersonalDataManagerFactory::GetForBrowserContext(profile);
  if (!data) {
    return 0;
  }
  int added = 0;
  for (const base::Value& item : list) {
    const base::DictValue* entry = item.GetIfDict();
    if (!entry) {
      continue;
    }
    auto text = [&](const char* key) {
      const std::string* value = entry->FindString(key);
      return value ? base::UTF8ToUTF16(*value) : std::u16string();
    };
    const std::string* country = entry->FindString("country");
    autofill::AutofillProfile address{autofill::AddressCountryCode(
        country && country->size() == 2 ? *country : std::string())};
    const std::pair<autofill::FieldType, const char*> fields[] = {
        {autofill::NAME_FULL, "name"},
        {autofill::COMPANY_NAME, "organization"},
        {autofill::ADDRESS_HOME_STREET_ADDRESS, "street"},
        {autofill::ADDRESS_HOME_CITY, "city"},
        {autofill::ADDRESS_HOME_STATE, "state"},
        {autofill::ADDRESS_HOME_ZIP, "zip"},
        {autofill::PHONE_HOME_WHOLE_NUMBER, "phone"},
        {autofill::EMAIL_ADDRESS, "email"},
    };
    bool any = false;
    for (const auto& [type, key] : fields) {
      const std::u16string value = text(key);
      if (!value.empty()) {
        address.SetRawInfo(type, value);
        any = true;
      }
    }
    if (!any) {
      continue;
    }
    address.FinalizeAfterImport();
    data->address_data_manager().AddProfile(address);
    ++added;
  }
  return added;
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
  const base::ListValue* cookies = data->FindList("cookies");
  applied.Set("cookies", cookies ? ApplyCookies(profile, *cookies) : 0);
  const base::ListValue* tabs = data->FindList("tabs");
  applied.Set("tabs", tabs ? ApplyTabs(profile, *tabs) : 0);
  const base::ListValue* engines = data->FindList("searchEngines");
  applied.Set("searchEngines", engines ? ApplySearchEngines(*writer, *engines) : 0);
  const base::ListValue* extensions = data->FindList("extensions");
  applied.Set("extensions",
              extensions ? ApplyExtensions(profile, *extensions) : 0);
  const base::ListValue* addresses = data->FindList("addresses");
  applied.Set("addresses",
              addresses ? ApplyAddresses(profile, *addresses) : 0);
  // Everything else stays sealed for a later version.
  base::ListValue skipped;
  for (const auto [key, value] : *data) {
    if (key != "bookmarks" && key != "history" && key != "passwords" &&
        key != "tabs" && key != "searchEngines" && key != "extensions" &&
        key != "addresses" && key != "cookies") {
      skipped.Append(key);
    }
  }
  std::move(reply).Run(base::DictValue()
                           .Set("applied", std::move(applied))
                           .Set("skipped", std::move(skipped)));
}

// The Perch profile with this name, made the first time a browser profile of
// that name is imported. Null when no profile can be made.
void InProfileNamed(const std::u16string& name,
                    base::OnceCallback<void(Profile*)> then) {
  ProfileManager* manager = g_browser_process->profile_manager();
  if (!manager) {
    std::move(then).Run(nullptr);
    return;
  }
  ProfileAttributesStorage& storage = manager->GetProfileAttributesStorage();
  for (ProfileAttributesEntry* entry : storage.GetAllProfilesAttributes()) {
    if (entry->GetName() == name) {
      manager->CreateProfileAsync(entry->GetPath(), std::move(then));
      return;
    }
  }
  ProfileManager::CreateMultiProfileAsync(
      name, storage.ChooseAvatarIconIndexForNewProfile(),
      /*is_hidden=*/false, std::move(then));
}

// Profiles share one window (toolbar/perch_profile_menu.cc): an imported
// profile's tabs wait in its own window, put away until the person switches
// to it from the profile menu.
void PutAwayProfileWindows(Profile* profile) {
  for (BrowserWindowInterface* window : GetAllBrowserWindowInterfaces()) {
    if (window->GetProfile() == profile) {
      window->GetWindow()->Hide();
    }
  }
}

// A profile made a moment ago is still loading its bookmarks, and the
// importer adds to the loaded bookmark tree; this waits for it (up to 30 s).
void WhenBookmarksLoaded(base::WeakPtr<Profile> profile,
                         int tries_left,
                         base::OnceCallback<void(Profile*)> then) {
  bookmarks::BookmarkModel* model =
      profile ? BookmarkModelFactory::GetForBrowserContext(profile.get())
              : nullptr;
  if (!profile || !model || model->loaded() || tries_left <= 0) {
    std::move(then).Run(profile && model && model->loaded() ? profile.get()
                                                             : nullptr);
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&WhenBookmarksLoaded, profile, tries_left - 1,
                     std::move(then)),
      base::Milliseconds(100));
}

void ApplyToNamedProfile(std::string name,
                         base::OnceCallback<void(DataResult)> reply,
                         std::optional<std::string> text) {
  InProfileNamed(
      base::UTF8ToUTF16(name),
      base::BindOnce(
          [](base::OnceCallback<void(DataResult)> reply,
             std::optional<std::string> text, Profile* profile) {
            if (!profile) {
              std::move(reply).Run(
                  base::unexpected("Perch couldn't make a profile for it"));
              return;
            }
            WhenBookmarksLoaded(
                profile->GetWeakPtr(), 300,
                base::BindOnce(
                    [](base::OnceCallback<void(DataResult)> reply,
                       std::optional<std::string> text, Profile* profile) {
                      if (!profile) {
                        std::move(reply).Run(base::unexpected(
                            "The new profile didn't finish opening"));
                        return;
                      }
                      // Set up already, in the profile it was imported
                      // from: its window opens on its tabs, not on setup.
                      profile->GetPrefs()->SetBoolean(
                          prefs::kOnboardingFinished, true);
                      profile->GetPrefs()->SetBoolean(prefs::kTourFinished,
                                                      true);
                      Apply(profile, std::move(reply), std::move(text));
                      PutAwayProfileWindows(profile);
                    },
                    std::move(reply), std::move(text)));
          },
          std::move(reply), std::move(text)));
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
  // One of several profiles imported together goes into a Perch profile of
  // its own name, not the one perchd works in.
  const std::string* name = params.FindString("profileName");
  if (name && !name->empty() && name->size() <= 100) {
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
        base::BindOnce(&ReadBundle, base::FilePath(*path)),
        base::BindOnce(&ApplyToNamedProfile, *name, std::move(reply)));
    return;
  }
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
      base::BindOnce(&ReadBundle, base::FilePath(*path)),
      base::BindOnce(&Apply, profile, std::move(reply)));
}

}  // namespace perch
