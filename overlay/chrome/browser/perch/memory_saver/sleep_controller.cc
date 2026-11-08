// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/memory_saver/sleep_controller.h"

#include <map>
#include <memory>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/supports_user_data.h"
#include "base/unguessable_token.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/performance_manager/policies/memory_saver_mode_policy.h"
#include "chrome/browser/perch/perch_built_in_policy.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/tab_list/tab_list_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "components/performance_manager/public/user_tuning/prefs.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/invalidate_type.h"
#include "content/public/browser/web_contents.h"
#include "url/gurl.h"

namespace perch {

namespace {

namespace tuning_prefs = performance_manager::user_tuning::prefs;

constexpr char kWatcherKey[] = "perch.memory_saver";

// Never-sleep rules by profile token. Read on the UI thread, where both the
// prefs and Chromium's discard check run.
std::map<base::UnguessableToken, std::vector<SleepRule>>& RulesByProfile() {
  static base::NoDestructor<
      std::map<base::UnguessableToken, std::vector<SleepRule>>>
      rules;
  return *rules;
}

void PushTimeout() {
  auto* policy =
      performance_manager::policies::MemorySaverModePolicy::GetInstance();
  const int minutes = GetSleepTimeoutMinutes();
  if (policy && minutes > 0) {
    policy->SetPerchTimeBeforeDiscard(base::Minutes(minutes));
  }
}

// Local State's timeout, followed once for the whole browser.
void WatchTimeout() {
  static base::NoDestructor<PrefChangeRegistrar> registrar;
  if (!registrar->IsEmpty() || !g_browser_process->local_state()) {
    return;
  }
  // An administrator turned the memory saver off (BuiltInExtensions).
  if (ForcedBuiltIn("memorySaver") == false) {
    g_browser_process->local_state()->SetInteger(
        tuning_prefs::kMemorySaverModeState,
        static_cast<int>(tuning_prefs::MemorySaverModeState::kDisabled));
  }
  registrar->Init(g_browser_process->local_state());
  registrar->Add(tuning_prefs::kMemorySaverModeTimeBeforeDiscardInMinutes,
                 base::BindRepeating(&PushTimeout));
  PushTimeout();
}

// Follows one profile's rules until the profile goes away.
class RulesWatcher : public base::SupportsUserData::Data {
 public:
  explicit RulesWatcher(Profile* profile) : token_(profile->UniqueToken()) {
    registrar_.Init(profile->GetPrefs());
    registrar_.Add(prefs::kMemorySaverRules,
                   base::BindRepeating(&RulesWatcher::Read,
                                       base::Unretained(this), profile));
    Read(profile);
  }
  ~RulesWatcher() override { RulesByProfile().erase(token_); }

 private:
  void Read(Profile* profile) {
    RulesByProfile()[token_] =
        RulesFromList(profile->GetPrefs()->GetList(prefs::kMemorySaverRules));
  }

  const base::UnguessableToken token_;
  PrefChangeRegistrar registrar_;
};

}  // namespace

bool IsSleepExempt(const base::UnguessableToken& profile_token,
                   const GURL& url) {
  auto it = RulesByProfile().find(profile_token);
  return it != RulesByProfile().end() && MatchesAny(url, it->second);
}

void WatchMemorySaver(Profile* profile) {
  WatchTimeout();
  if (!profile || profile->GetUserData(kWatcherKey)) {
    return;
  }
  profile->SetUserData(kWatcherKey, std::make_unique<RulesWatcher>(profile));
}

std::vector<SleepRule> GetSleepRules(Profile* profile) {
  return RulesFromList(profile->GetPrefs()->GetList(prefs::kMemorySaverRules));
}

void SetSleepRules(Profile* profile, const std::vector<SleepRule>& rules) {
  profile->GetPrefs()->SetList(prefs::kMemorySaverRules, RulesToList(rules));
}

int GetSleepTimeoutMinutes() {
  const PrefService* local_state = g_browser_process->local_state();
  if (!local_state || ForcedBuiltIn("memorySaver") == false ||
      local_state->GetInteger(tuning_prefs::kMemorySaverModeState) !=
          static_cast<int>(tuning_prefs::MemorySaverModeState::kEnabled)) {
    return 0;
  }
  return local_state->GetInteger(
      tuning_prefs::kMemorySaverModeTimeBeforeDiscardInMinutes);
}

bool IsMemorySaverManaged() {
  return ForcedBuiltIn("memorySaver").has_value();
}

void SetSleepTimeoutMinutes(int minutes) {
  PrefService* local_state = g_browser_process->local_state();
  if (!local_state || IsMemorySaverManaged()) {
    return;
  }
  const auto state = minutes > 0 ? tuning_prefs::MemorySaverModeState::kEnabled
                                 : tuning_prefs::MemorySaverModeState::kDisabled;
  if (minutes > 0) {
    local_state->SetInteger(
        tuning_prefs::kMemorySaverModeTimeBeforeDiscardInMinutes, minutes);
  }
  local_state->SetInteger(tuning_prefs::kMemorySaverModeState,
                          static_cast<int>(state));
}

void SleepTab(tabs::TabInterface* tab) {
  // A page still loading can't sleep yet: Chromium expects a discarded tab
  // to have finished.
  if (!tab || !tab->GetBrowserWindowInterface() ||
      tab->GetContents()->IsLoading()) {
    return;
  }
  TabListInterface* tabs =
      TabListInterface::From(tab->GetBrowserWindowInterface());
  if (!tabs) {
    return;
  }
  const int index = tabs->GetIndexOfTab(tab->GetHandle());
  if (index < 0) {
    return;
  }
  if (index == tabs->GetActiveIndex()) {
    // A visible tab can't sleep: move to the tab on the right, or the left.
    const int count = tabs->GetTabCount();
    if (count < 2) {
      return;
    }
    tabs->ActivateTab(
        tabs->GetTab(index + 1 < count ? index + 1 : index - 1)->GetHandle());
  }
  content::WebContents* asleep = tabs->DiscardTab(tab->GetHandle());
  // Chromium redraws a tab it put to sleep itself; ask for the moon here.
  if (asleep) {
    asleep->NotifyNavigationStateChanged(content::INVALIDATE_TYPE_TAB);
  }
}

void NeverSleepSite(Profile* profile, const GURL& url) {
  if (!profile || !url.SchemeIsHTTPOrHTTPS()) {
    return;
  }
  auto rule = ParseSleepPattern(url.host());
  if (!rule.has_value()) {
    return;
  }
  std::vector<SleepRule> rules = GetSleepRules(profile);
  if (!MatchesAny(url, rules)) {
    rules.push_back(*rule);
    SetSleepRules(profile, rules);
  }
}

}  // namespace perch
