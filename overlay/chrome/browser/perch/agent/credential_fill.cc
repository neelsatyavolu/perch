// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/credential_fill.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/json/string_escape.h"
#include "base/memory/weak_ptr.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/stringprintf.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/autofill/personal_data_manager_factory.h"
#include "chrome/browser/password_manager/factories/profile_password_store_factory.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/common/chrome_isolated_world_ids.h"
#include "components/autofill/core/browser/data_manager/payments/payments_data_manager.h"
#include "components/autofill/core/browser/data_manager/personal_data_manager.h"
#include "components/autofill/core/browser/data_model/payments/credit_card.h"
#include "components/autofill/core/browser/field_types.h"
#include "components/password_manager/core/browser/password_form_digest.h"
#include "components/password_manager/core/browser/password_store/password_store_consumer.h"
#include "components/password_manager/core/browser/password_store/password_store_interface.h"
#include "components/password_manager/core/browser/password_store/stored_credential.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/render_frame_host.h"
#include "content/public/browser/web_contents.h"
#include "content/public/browser/global_routing_id.h"
#include "crypto/hash.h"
#include "url/gurl.h"
#include "url/origin.h"

namespace perch {

namespace {

content::WebContents* ContentsFor(const base::DictValue& params) {
  const std::string* target = params.FindString("targetId");
  scoped_refptr<content::DevToolsAgentHost> host =
      target ? content::DevToolsAgentHost::GetForId(*target) : nullptr;
  return host ? host->GetWebContents() : nullptr;
}

Profile* ProfileOf(content::WebContents* contents) {
  return Profile::FromBrowserContext(contents->GetBrowserContext());
}

// A stable id for a login that says nothing about it.
std::string LoginId(const password_manager::StoredCredential& login) {
  const std::string text =
      login.signon_realm + "\n" + base::UTF16ToUTF8(login.username_value);
  return base::HexEncode(crypto::hash::Sha256(base::as_byte_span(text)))
      .substr(0, 32);
}

std::string Quoted(const std::u16string& value) {
  return base::GetQuotedJSONString(value);
}

// Sets an input as typing would, and marks it so snapshots can leave it out.
constexpr char kSetter[] = R"JS(
  const visible = (el) => el && !el.disabled && !el.readOnly &&
      el.getClientRects().length > 0;
  const set = (el, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
        .set.call(el, value);
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    el.setAttribute('data-perch-filled', '');
  };
)JS";

std::u16string LoginScript(const std::u16string& username,
                           const std::u16string& password) {
  return base::UTF8ToUTF16(base::StringPrintf(
      R"JS((() => {%s
  const user = %s, pass = %s;
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const pw = inputs.find((el) => el.type === 'password');
  const isUser = (el) => ['text', 'email', 'tel', ''].includes(el.type) ||
      /username|email/.test(el.autocomplete || '');
  if (!pw) {
    // The first step of a two-step sign-in: the username alone.
    const only = inputs.find((el) => /username|email/.test(el.autocomplete || '')) ||
        inputs.find((el) => el.type === 'email');
    if (!only) return 'no-form';
    set(only, user);
    return 'filled';
  }
  const before = inputs.slice(0, inputs.indexOf(pw)).reverse().find(isUser);
  if (before && user) set(before, user);
  set(pw, pass);
  return 'filled';
})())JS",
      kSetter, Quoted(username).c_str(), Quoted(password).c_str()));
}

std::u16string CardScript(const std::u16string& number,
                          const std::u16string& name,
                          int month,
                          int year) {
  return base::UTF8ToUTF16(base::StringPrintf(
      R"JS((() => {%s
  const number = %s, name = %s, month = %d, year = %d;
  const two = (n) => String(n).padStart(2, '0');
  const values = {
    'cc-number': number, 'cc-name': name, 'cc-exp': two(month) + '/' + two(year %% 100),
    'cc-exp-month': two(month), 'cc-exp-year': String(year),
  };
  const fields = [...document.querySelectorAll('input, select')].filter(visible);
  let filled = 0, needsCode = false;
  for (const el of fields) {
    const hint = (el.autocomplete || '').split(/\s+/).find((t) => t.startsWith('cc-'));
    if (hint === 'cc-csc') { needsCode = true; continue; }
    if (!hint || !(hint in values)) continue;
    if (el.tagName === 'SELECT') {
      const want = values[hint];
      const option = [...el.options].find((o) => o.value === want ||
          o.value === String(Number(want)) || o.text.trim() === want);
      if (!option) continue;
      el.value = option.value;
      el.dispatchEvent(new Event('change', {bubbles: true}));
      el.setAttribute('data-perch-filled', '');
    } else {
      set(el, values[hint]);
    }
    filled++;
  }
  if (!filled) return 'no-form';
  return needsCode ? 'needs-user' : 'filled';
})())JS",
      kSetter, Quoted(number).c_str(), Quoted(name).c_str(), month, year));
}

void RunFill(content::WebContents* contents,
             std::u16string script,
             base::OnceCallback<void(DataResult)> reply) {
  contents->GetPrimaryMainFrame()->ExecuteJavaScriptInIsolatedWorld(
      script,
      base::BindOnce(
          [](base::OnceCallback<void(DataResult)> reply, base::Value result) {
            const std::string* outcome = result.GetIfString();
            std::move(reply).Run(
                base::DictValue()
                    .Set("result", outcome ? *outcome : "failed")
                    .Set("fields", base::ListValue()));
          },
          std::move(reply)),
      ISOLATED_WORLD_ID_CHROME_INTERNAL);
}

// Fetches the saved logins for a page, then hands them on. Owns itself.
class LoginFetcher : public password_manager::PasswordStoreConsumer {
 public:
  using Done =
      base::OnceCallback<void(std::vector<password_manager::StoredCredential>)>;

  static void Start(content::WebContents* contents, Done done) {
    auto* fetcher = new LoginFetcher(std::move(done));
    scoped_refptr<password_manager::PasswordStoreInterface> store =
        ProfilePasswordStoreFactory::GetForProfile(
            ProfileOf(contents), ServiceAccessType::EXPLICIT_ACCESS);
    const GURL url = contents->GetLastCommittedURL();
    if (!store || !url.SchemeIsHTTPOrHTTPS()) {
      fetcher->Finish({});
      return;
    }
    store->GetLogins(
        password_manager::PasswordFormDigest(
            password_manager::PasswordForm::Scheme::kHtml,
            url::Origin::Create(url).GetURL().spec(), url),
        fetcher->weak_factory_.GetWeakPtr());
  }

  void OnGetPasswordStoreResultsOrErrorFrom(
      password_manager::PasswordStoreInterface* store,
      base::expected<std::vector<password_manager::StoredCredential>,
                     password_manager::PasswordStoreBackendError> results)
      override {
    std::vector<password_manager::StoredCredential> logins;
    if (results.has_value()) {
      for (password_manager::StoredCredential& login : *results) {
        if (!login.blocked_by_user && !login.password_value.empty()) {
          logins.push_back(std::move(login));
        }
      }
    }
    Finish(std::move(logins));
  }

 private:
  explicit LoginFetcher(Done done) : done_(std::move(done)) {}

  void Finish(std::vector<password_manager::StoredCredential> logins) {
    std::move(done_).Run(std::move(logins));
    delete this;
  }

  Done done_;
  base::WeakPtrFactory<LoginFetcher> weak_factory_{this};
};

}  // namespace

void ListLogins(const base::DictValue& params,
                base::OnceCallback<void(DataResult)> reply) {
  content::WebContents* contents = ContentsFor(params);
  if (!contents) {
    std::move(reply).Run(base::unexpected("No tab with that target id"));
    return;
  }
  LoginFetcher::Start(
      contents,
      base::BindOnce(
          [](base::OnceCallback<void(DataResult)> reply,
             std::vector<password_manager::StoredCredential> logins) {
            base::ListValue list;
            for (const auto& login : logins) {
              list.Append(base::DictValue()
                              .Set("loginId", LoginId(login))
                              .Set("username",
                                   base::UTF16ToUTF8(login.username_value))
                              .Set("origin", login.signon_realm));
            }
            std::move(reply).Run(base::DictValue().Set("logins", std::move(list)));
          },
          std::move(reply)));
}

void FillLogin(const base::DictValue& params,
               base::OnceCallback<void(DataResult)> reply) {
  content::WebContents* contents = ContentsFor(params);
  const std::string* login_id = params.FindString("loginId");
  if (!contents || !login_id) {
    std::move(reply).Run(base::unexpected("targetId and loginId are required"));
    return;
  }
  // The lookup is async: fill only if the tab still shows the same page.
  content::RenderFrameHost* frame = contents->GetPrimaryMainFrame();
  const content::GlobalRenderFrameHostId frame_id = frame->GetGlobalId();
  const url::Origin origin = frame->GetLastCommittedOrigin();
  LoginFetcher::Start(
      contents,
      base::BindOnce(
          [](base::WeakPtr<content::WebContents> contents, std::string id,
             content::GlobalRenderFrameHostId frame_id, url::Origin origin,
             base::OnceCallback<void(DataResult)> reply,
             std::vector<password_manager::StoredCredential> logins) {
            content::RenderFrameHost* now =
                contents ? contents->GetPrimaryMainFrame() : nullptr;
            if (!now || now->GetGlobalId() != frame_id ||
                !now->GetLastCommittedOrigin().IsSameOriginWith(origin)) {
              std::move(reply).Run(
                  base::unexpected("The page changed before the fill"));
              return;
            }
            for (const auto& login : logins) {
              if (LoginId(login) == id) {
                RunFill(contents.get(),
                        LoginScript(login.username_value,
                                    login.password_value.value()),
                        std::move(reply));
                return;
              }
            }
            std::move(reply).Run(base::DictValue()
                                     .Set("result", "failed")
                                     .Set("fields", base::ListValue()));
          },
          contents->GetWeakPtr(), *login_id, frame_id, origin,
          std::move(reply)));
}

DataResult ListCards(const base::DictValue& params) {
  content::WebContents* contents = ContentsFor(params);
  autofill::PersonalDataManager* data =
      contents ? autofill::PersonalDataManagerFactory::GetForBrowserContext(
                     contents->GetBrowserContext())
               : nullptr;
  if (!data) {
    return base::unexpected("No tab with that target id");
  }
  base::ListValue cards;
  for (const autofill::CreditCard* card :
       data->payments_data_manager().GetLocalCreditCards()) {
    cards.Append(
        base::DictValue()
            .Set("cardId", card->guid())
            .Set("network", base::UTF16ToUTF8(card->NetworkForDisplay()))
            .Set("lastFour", base::UTF16ToUTF8(card->LastFourDigits()))
            .Set("expiry",
                 base::StringPrintf("%02d/%02d", card->expiration_month(),
                                    card->expiration_year() % 100)));
  }
  return base::DictValue().Set("cards", std::move(cards));
}

void FillCard(const base::DictValue& params,
              base::OnceCallback<void(DataResult)> reply) {
  content::WebContents* contents = ContentsFor(params);
  const std::string* card_id = params.FindString("cardId");
  autofill::PersonalDataManager* data =
      contents ? autofill::PersonalDataManagerFactory::GetForBrowserContext(
                     contents->GetBrowserContext())
               : nullptr;
  if (!data || !card_id) {
    std::move(reply).Run(base::unexpected("targetId and cardId are required"));
    return;
  }
  for (const autofill::CreditCard* card :
       data->payments_data_manager().GetLocalCreditCards()) {
    if (card->guid() == *card_id) {
      RunFill(contents,
              CardScript(card->GetRawInfo(autofill::CREDIT_CARD_NUMBER),
                         card->GetRawInfo(autofill::CREDIT_CARD_NAME_FULL),
                         card->expiration_month(), card->expiration_year()),
              std::move(reply));
      return;
    }
  }
  std::move(reply).Run(
      base::DictValue().Set("result", "failed").Set("fields", base::ListValue()));
}

}  // namespace perch
