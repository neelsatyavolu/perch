// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/settings/privacy.h"

#include <optional>
#include <string_view>
#include <utility>

#include "base/functional/bind.h"
#include "base/strings/string_util.h"
#include "base/time/time.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/browsing_data/chrome_browsing_data_remover_constants.h"
#include "chrome/browser/perch/extensions/perch_component_extensions.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/perch/privacy/allowed_connections.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/pref_names.h"
#include "components/content_settings/core/browser/cookie_settings.h"
#include "components/content_settings/core/common/pref_names.h"
#include "components/prefs/pref_service.h"
#include "components/privacy_sandbox/privacy_sandbox_prefs.h"
#include "content/public/browser/browsing_data_filter_builder.h"
#include "content/public/browser/browsing_data_remover.h"
#include "extensions/browser/api/storage/storage_area_namespace.h"
#include "extensions/browser/api/storage/storage_frontend.h"
#include "extensions/browser/extension_registry.h"
#include "net/base/registry_controlled_domains/registry_controlled_domain.h"
#include "url/gurl.h"

namespace perch {

namespace {

// The extension's storage key and its switch names (extension/src/shared/
// settings.ts), by PrivacySettings field.
constexpr char kSettingsKey[] = "settings";
constexpr std::pair<std::string_view, std::string_view> kBlockerFields[] = {
    {"contentBlocker", "blocker"},
    {"cookieBanners", "banners"},
    {"trackingParams", "params"},
};

// DNS over HTTPS providers and their templates. "off", "automatic" and
// "secure" are Chromium's SecureDnsConfig modes.
constexpr std::pair<std::string_view, std::string_view> kDohProviders[] = {
    {"cloudflare", "https://chrome.cloudflare-dns.com/dns-query"},
    {"quad9", "https://dns.quad9.net/dns-query"},
    {"mullvad", "https://dns.mullvad.net/dns-query"},
};

std::optional<std::string_view> TemplateFor(std::string_view provider) {
  for (const auto& [name, url] : kDohProviders) {
    if (name == provider) {
      return url;
    }
  }
  return std::nullopt;
}

scoped_refptr<const extensions::Extension> PerchExtension(Profile* profile) {
  return scoped_refptr<const extensions::Extension>(
      extensions::ExtensionRegistry::Get(profile)->enabled_extensions().GetByID(
          kPerchExtensionId));
}

using SettingsCallback =
    base::OnceCallback<void(std::optional<base::DictValue>)>;

// The extension's settings object, or nullopt when the extension is off.
void ReadBlockerSettings(Profile* profile, SettingsCallback callback) {
  scoped_refptr<const extensions::Extension> extension =
      PerchExtension(profile);
  if (!extension) {
    std::move(callback).Run(std::nullopt);
    return;
  }
  extensions::StorageFrontend::Get(profile)->GetValues(
      extension, extensions::StorageAreaNamespace::kLocal,
      std::vector<std::string>{kSettingsKey},
      base::BindOnce(
          [](SettingsCallback callback,
             extensions::StorageFrontend::GetResult result) {
            base::DictValue settings;
            if (result.data) {
              if (base::DictValue* stored =
                      result.data->FindDict(kSettingsKey)) {
                settings = std::move(*stored);
              }
            }
            std::move(callback).Run(std::move(settings));
          },
          std::move(callback)));
}

void WriteBlockerSettings(Profile* profile,
                          base::DictValue settings,
                          base::OnceClosure done) {
  scoped_refptr<const extensions::Extension> extension =
      PerchExtension(profile);
  if (!extension) {
    std::move(done).Run();
    return;
  }
  base::DictValue values;
  values.Set(kSettingsKey, std::move(settings));
  extensions::StorageFrontend::Get(profile)->Set(
      extension, extensions::StorageAreaNamespace::kLocal, std::move(values),
      base::BindOnce(
          [](base::OnceClosure done,
             extensions::StorageFrontend::ResultStatus) {
            std::move(done).Run();
          },
          std::move(done)));
}

base::DictValue Snapshot(Profile* profile,
                         const std::optional<base::DictValue>& blocker) {
  const PrefService* prefs = profile->GetPrefs();
  const PrefService* local = g_browser_process->local_state();
  base::DictValue result;
  for (const auto& [field, key] : kBlockerFields) {
    // A missing switch is on (DEFAULT_SETTINGS); the extension turned off
    // means every switch is off.
    result.Set(field, blocker.has_value() &&
                          blocker->FindBool(key).value_or(true));
  }
  base::ListValue exceptions;
  if (blocker) {
    if (const base::ListValue* sites = blocker->FindList("sitesOff")) {
      for (const base::Value& site : *sites) {
        if (site.is_string()) {
          exceptions.Append(site.GetString());
        }
      }
    }
  }
  result.Set("blockerExceptions", std::move(exceptions));
  result.Set("httpsOnly", prefs->GetBoolean(::prefs::kHttpsOnlyModeEnabled));

  const std::string mode = local->GetString(::prefs::kDnsOverHttpsMode);
  const std::string templates =
      local->GetString(::prefs::kDnsOverHttpsTemplates);
  std::string provider = "custom";
  for (const auto& [name, url] : kDohProviders) {
    if (templates == url) {
      provider = std::string(name);
    }
  }
  if (templates.empty()) {
    provider = "cloudflare";
  }
  result.Set("dnsOverHttps", mode != "off");
  result.Set("dohProvider", provider);
  result.Set("dohCustomUrl", provider == "custom" ? templates : std::string());

  result.Set("fingerprinting", prefs->GetBoolean(prefs::kFingerprinting));
  result.Set("thirdPartyCookies",
             prefs->GetInteger(::prefs::kCookieControlsMode) ==
                     static_cast<int>(
                         content_settings::CookieControlsMode::kBlockThirdParty)
                 ? "block"
                 : "allow");
  result.Set("backgroundConnections", ListConnections(*local));
  return result;
}

// Checks the whole patch before anything is written.
std::optional<std::string> Validate(const base::DictValue& patch) {
  for (const auto [key, value] : patch) {
    bool is_bool_field = key == "httpsOnly" || key == "dnsOverHttps" ||
                         key == "fingerprinting";
    for (const auto& [field, unused] : kBlockerFields) {
      is_bool_field |= key == field;
    }
    if (is_bool_field) {
      if (!value.is_bool()) {
        return key + " must be true or false";
      }
    } else if (key == "dohProvider") {
      if (!value.is_string() ||
          (value.GetString() != "custom" && !TemplateFor(value.GetString()))) {
        return "Unknown DNS provider";
      }
    } else if (key == "dohCustomUrl") {
      if (!value.is_string()) {
        return "The DNS address must be text";
      }
    } else if (key == "thirdPartyCookies") {
      if (!value.is_string() ||
          (value.GetString() != "block" && value.GetString() != "allow")) {
        return "thirdPartyCookies must be block or allow";
      }
    } else {
      return "Unknown privacy setting " + key;
    }
  }
  const std::string* provider = patch.FindString("dohProvider");
  if (provider && *provider == "custom") {
    const std::string* url = patch.FindString("dohCustomUrl");
    const GURL parsed(url ? *url : std::string());
    if (!parsed.is_valid() || !parsed.SchemeIs("https")) {
      return "A custom DNS provider needs an https:// address";
    }
  }
  return std::nullopt;
}

void ApplyPrefs(Profile* profile, const base::DictValue& patch) {
  PrefService* prefs = profile->GetPrefs();
  PrefService* local = g_browser_process->local_state();
  if (std::optional<bool> on = patch.FindBool("httpsOnly")) {
    prefs->SetBoolean(::prefs::kHttpsOnlyModeEnabled, *on);
  }
  if (std::optional<bool> on = patch.FindBool("fingerprinting")) {
    prefs->SetBoolean(prefs::kFingerprinting, *on);
    // On turns the ad-targeting APIs off. Off leaves them as they are; they
    // stay off unless the user turns them on in chrome://settings.
    if (*on) {
      prefs->SetBoolean(::prefs::kPrivacySandboxM1TopicsEnabled, false);
      prefs->SetBoolean(::prefs::kPrivacySandboxM1FledgeEnabled, false);
      prefs->SetBoolean(::prefs::kPrivacySandboxM1AdMeasurementEnabled, false);
    }
  }
  if (const std::string* cookies = patch.FindString("thirdPartyCookies")) {
    prefs->SetInteger(
        ::prefs::kCookieControlsMode,
        static_cast<int>(*cookies == "block"
                             ? content_settings::CookieControlsMode::
                                   kBlockThirdParty
                             : content_settings::CookieControlsMode::kOff));
  }
  if (const std::string* provider = patch.FindString("dohProvider")) {
    const std::string* custom = patch.FindString("dohCustomUrl");
    local->SetString(::prefs::kDnsOverHttpsTemplates,
                     *provider == "custom"
                         ? *custom
                         : std::string(*TemplateFor(*provider)));
  }
  if (std::optional<bool> on = patch.FindBool("dnsOverHttps")) {
    if (*on && local->GetString(::prefs::kDnsOverHttpsTemplates).empty()) {
      local->SetString(::prefs::kDnsOverHttpsTemplates,
                       std::string(*TemplateFor("cloudflare")));
    }
    // Automatic mode uses the resolver when it answers and falls back to the
    // system's otherwise (spec 5.9).
    local->SetString(::prefs::kDnsOverHttpsMode, *on ? "automatic" : "off");
  }
}

void Reply(base::WeakPtr<Profile> profile, PrivacyCallback callback) {
  if (!profile) {
    return;
  }
  GetPrivacy(profile.get(), std::move(callback));
}

}  // namespace

void GetPrivacy(Profile* profile, PrivacyCallback callback) {
  ReadBlockerSettings(
      profile, base::BindOnce(
                   [](base::WeakPtr<Profile> profile, PrivacyCallback callback,
                      std::optional<base::DictValue> blocker) {
                     if (profile) {
                       std::move(callback).Run(
                           Snapshot(profile.get(), blocker));
                     }
                   },
                   profile->GetWeakPtr(), std::move(callback)));
}

void SetPrivacy(Profile* profile,
                const base::DictValue& patch,
                PrivacyCallback callback) {
  if (std::optional<std::string> error = Validate(patch)) {
    std::move(callback).Run(base::unexpected(*error));
    return;
  }
  ApplyPrefs(profile, patch);
  base::DictValue switches;
  for (const auto& [field, key] : kBlockerFields) {
    if (std::optional<bool> on = patch.FindBool(field)) {
      switches.Set(key, *on);
    }
  }
  if (switches.empty()) {
    GetPrivacy(profile, std::move(callback));
    return;
  }
  if (!PerchExtension(profile)) {
    std::move(callback).Run(base::unexpected(
        "Turn the Perch extension on in Settings → Built in to change this"));
    return;
  }
  ReadBlockerSettings(
      profile,
      base::BindOnce(
          [](base::WeakPtr<Profile> profile, base::DictValue switches,
             PrivacyCallback callback, std::optional<base::DictValue> stored) {
            if (!profile) {
              return;
            }
            base::DictValue settings =
                stored ? std::move(*stored) : base::DictValue();
            settings.Merge(std::move(switches));
            WriteBlockerSettings(
                profile.get(), std::move(settings),
                base::BindOnce(&Reply, profile, std::move(callback)));
          },
          profile->GetWeakPtr(), std::move(switches), std::move(callback)));
}

void SetBackgroundConnection(Profile* profile,
                             const std::string& id,
                             bool enabled,
                             PrivacyCallback callback) {
  if (!SetConnectionAllowed(*g_browser_process->local_state(), id, enabled)) {
    std::move(callback).Run(base::unexpected("Unknown connection"));
    return;
  }
  GetPrivacy(profile, std::move(callback));
}

void RemoveBlockerException(Profile* profile,
                            const std::string& host,
                            PrivacyCallback callback) {
  const std::string lower = base::ToLowerASCII(host);
  ReadBlockerSettings(
      profile,
      base::BindOnce(
          [](base::WeakPtr<Profile> profile, std::string host,
             PrivacyCallback callback, std::optional<base::DictValue> stored) {
            if (!profile) {
              return;
            }
            if (!stored) {
              GetPrivacy(profile.get(), std::move(callback));
              return;
            }
            base::DictValue settings = std::move(*stored);
            if (base::ListValue* sites = settings.FindList("sitesOff")) {
              sites->EraseIf([&](const base::Value& site) {
                return site.is_string() &&
                       (site.GetString() == host ||
                        base::EndsWith(host, "." + site.GetString()));
              });
            }
            WriteBlockerSettings(
                profile.get(), std::move(settings),
                base::BindOnce(&Reply, profile, std::move(callback)));
          },
          profile->GetWeakPtr(), lower, std::move(callback)));
}

bool ForgetSite(Profile* profile, const std::string& host) {
  const GURL url("https://" + base::ToLowerASCII(host) + "/");
  if (!url.is_valid() || url.host().empty()) {
    return false;
  }
  std::string domain =
      net::registry_controlled_domains::GetDomainAndRegistry(
          url, net::registry_controlled_domains::INCLUDE_PRIVATE_REGISTRIES);
  if (domain.empty()) {
    domain = std::string(url.host());
  }
  std::unique_ptr<content::BrowsingDataFilterBuilder> filter =
      content::BrowsingDataFilterBuilder::Create(
          content::BrowsingDataFilterBuilder::Mode::kDelete);
  filter->AddRegisterableDomain(domain);
  profile->GetBrowsingDataRemover()->RemoveWithFilter(
      base::Time(), base::Time::Max(),
      chrome_browsing_data_remover::DATA_TYPE_SITE_DATA |
          content::BrowsingDataRemover::DATA_TYPE_CACHE,
      content::BrowsingDataRemover::ORIGIN_TYPE_UNPROTECTED_WEB,
      std::move(filter));
  return true;
}

}  // namespace perch
