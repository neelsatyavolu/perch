// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/memory_saver/memory_saver_settings.h"

#include <algorithm>
#include <vector>

#include "base/memory/weak_ptr.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/perch/memory_saver/sleep_controller.h"
#include "chrome/browser/perch/memory_saver/sleep_rules.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/performance_manager/public/graph/page_node.h"
#include "components/performance_manager/public/performance_manager.h"
#include "content/public/browser/web_contents.h"

namespace perch {

namespace {

// The longest wait the page offers is 4 hours; a day is the most Perch takes.
constexpr int kMaxTimeoutMinutes = 24 * 60;

}  // namespace

base::DictValue GetMemorySaverSettings(Profile* profile) {
  return base::DictValue()
      .Set("timeoutMinutes", GetSleepTimeoutMinutes())
      .Set("rules", RulesToList(GetSleepRules(profile)));
}

base::expected<base::DictValue, std::string> SetMemorySaverSettings(
    Profile* profile,
    const base::DictValue& patch) {
  const base::Value* timeout = patch.Find("timeoutMinutes");
  if (timeout && (!timeout->is_int() || timeout->GetInt() < 0 ||
                  timeout->GetInt() > kMaxTimeoutMinutes)) {
    return base::unexpected("Choose a time between 0 minutes and a day");
  }
  const base::Value* rules = patch.Find("rules");
  if (rules && !rules->is_list()) {
    return base::unexpected("Send the rules as a list");
  }
  if (rules) {
    std::vector<SleepRule> parsed = RulesFromList(rules->GetList());
    if (parsed.size() != rules->GetList().size()) {
      return base::unexpected("One of the rules isn't one Perch can read");
    }
    SetSleepRules(profile, parsed);
  }
  if (timeout) {
    SetSleepTimeoutMinutes(timeout->GetInt());
  }
  return GetMemorySaverSettings(profile);
}

base::expected<base::DictValue, std::string> AddSleepRule(
    Profile* profile,
    const std::string& input) {
  base::expected<SleepRule, std::string> rule = ParseSleepPattern(input);
  if (!rule.has_value()) {
    return base::unexpected(rule.error());
  }
  std::vector<SleepRule> rules = GetSleepRules(profile);
  if (std::find(rules.begin(), rules.end(), *rule) == rules.end()) {
    rules.push_back(*rule);
    SetSleepRules(profile, rules);
  }
  return GetMemorySaverSettings(profile);
}

base::ListValue ListTabMemory(Profile* profile) {
  base::ListValue list;
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    if (browser->GetProfile() != profile) {
      continue;
    }
    TabStripModel* tabs = browser->GetTabStripModel();
    for (int i = 0; i < tabs->count(); ++i) {
      content::WebContents* contents = tabs->GetWebContentsAt(i);
      const bool asleep = contents->WasDiscarded();
      int64_t bytes = 0;
      if (!asleep) {
        base::WeakPtr<performance_manager::PageNode> page =
            performance_manager::PerformanceManager::
                GetPrimaryPageNodeForWebContents(contents);
        if (page) {
          bytes = page->EstimatePrivateFootprintSize().InBytes();
        }
      }
      list.Append(base::DictValue()
                      .Set("title", base::UTF16ToUTF8(contents->GetTitle()))
                      .Set("url", contents->GetVisibleURL().spec())
                      .Set("bytes", static_cast<double>(bytes))
                      .Set("asleep", asleep));
    }
  }
  return list;
}

}  // namespace perch
