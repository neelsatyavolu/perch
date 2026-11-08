// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/spaces/spaces.h"

#include <algorithm>
#include <utility>

#include "base/strings/string_number_conversions.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_tabrestore.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_enums.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "components/prefs/pref_service.h"
#include "components/sessions/core/serialized_navigation_entry.h"
#include "components/sessions/core/serialized_user_agent_override.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/page_transition_types.h"

namespace perch {

namespace {

constexpr char kId[] = "id";
constexpr char kName[] = "name";
constexpr char kTabs[] = "tabs";

// The spaces, never empty: a profile starts with one called Home.
base::ListValue ReadSpaces(Profile* profile) {
  base::ListValue spaces = profile->GetPrefs()->GetList(prefs::kSpaces).Clone();
  if (spaces.empty()) {
    spaces.Append(base::DictValue()
                      .Set(kId, "1")
                      .Set(kName, "Home")
                      .Set(kTabs, base::ListValue()));
  }
  return spaces;
}

size_t ActiveIndex(Profile* profile, const base::ListValue& spaces) {
  const std::string& active = profile->GetPrefs()->GetString(prefs::kActiveSpace);
  for (size_t i = 0; i < spaces.size(); ++i) {
    const std::string* id = spaces[i].GetDict().FindString(kId);
    if (id && *id == active) {
      return i;
    }
  }
  return 0;
}

void Write(Profile* profile, base::ListValue spaces, size_t active) {
  const std::string* id = spaces[active].GetDict().FindString(kId);
  profile->GetPrefs()->SetString(prefs::kActiveSpace, id ? *id : "1");
  profile->GetPrefs()->SetList(prefs::kSpaces, std::move(spaces));
}

std::string NextId(const base::ListValue& spaces) {
  int highest = 0;
  for (const base::Value& space : spaces) {
    int value = 0;
    const std::string* id = space.GetDict().FindString(kId);
    if (id && base::StringToInt(*id, &value)) {
      highest = std::max(highest, value);
    }
  }
  return base::NumberToString(highest + 1);
}

base::ListValue CaptureTabs(BrowserWindowInterface* browser) {
  TabStripModel* tabs = browser->GetTabStripModel();
  base::ListValue list;
  for (int i = 0; i < tabs->count(); ++i) {
    content::WebContents* contents = tabs->GetWebContentsAt(i);
    list.Append(base::DictValue()
                    .Set("url", contents->GetVisibleURL().spec())
                    .Set("title", contents->GetTitle())
                    .Set("pinned", tabs->IsTabPinned(i))
                    .Set("active", i == tabs->active_index()));
  }
  return list;
}

std::vector<SpaceTab> TabsFrom(const base::ListValue& list) {
  std::vector<SpaceTab> tabs;
  for (const base::Value& item : list) {
    const base::DictValue& tab = item.GetDict();
    const std::string* url = tab.FindString("url");
    const std::string* title = tab.FindString("title");
    if (!url || !GURL(*url).is_valid()) {
      continue;
    }
    tabs.push_back({GURL(*url), title ? base::UTF8ToUTF16(*title) : u"",
                    tab.FindBool("pinned").value_or(false),
                    tab.FindBool("active").value_or(false)});
  }
  return tabs;
}

// Shows `tabs` in place of the window's current tabs.
void ReplaceTabs(BrowserWindowInterface* browser, std::vector<SpaceTab> tabs) {
  TabStripModel* model = browser->GetTabStripModel();
  std::vector<tabs::TabHandle> old;
  for (int i = 0; i < model->count(); ++i) {
    old.push_back(model->GetTabAtIndex(i)->GetHandle());
  }
  if (tabs.empty()) {
    tabs.push_back({GURL("chrome://newtab/"), u"", false, true});
  }
  OpenTabsAsleep(browser, tabs);
  for (const tabs::TabHandle& handle : old) {
    const int index = model->GetIndexOfTab(handle.Get());
    if (index != TabStripModel::kNoTab) {
      model->CloseWebContentsAt(index, TabCloseTypes::CLOSE_NONE);
    }
  }
}

}  // namespace

std::vector<SpaceInfo> ListSpaces(Profile* profile) {
  const base::ListValue spaces = ReadSpaces(profile);
  const size_t active = ActiveIndex(profile, spaces);
  std::vector<SpaceInfo> list;
  for (size_t i = 0; i < spaces.size(); ++i) {
    const base::DictValue& space = spaces[i].GetDict();
    const std::string* id = space.FindString(kId);
    const std::string* name = space.FindString(kName);
    list.push_back({id ? *id : "", name ? base::UTF8ToUTF16(*name) : u"",
                    i == active});
  }
  return list;
}

std::u16string ActiveSpaceName(Profile* profile) {
  for (const SpaceInfo& space : ListSpaces(profile)) {
    if (space.active) {
      return space.name;
    }
  }
  return u"";
}

void SwitchToSpace(BrowserWindowInterface* browser, size_t index) {
  Profile* profile = browser->GetProfile();
  base::ListValue spaces = ReadSpaces(profile);
  const size_t active = ActiveIndex(profile, spaces);
  if (index >= spaces.size() || index == active) {
    return;
  }
  spaces[active].GetDict().Set(kTabs, CaptureTabs(browser));
  std::vector<SpaceTab> target =
      TabsFrom(*spaces[index].GetDict().FindList(kTabs));
  spaces[index].GetDict().Set(kTabs, base::ListValue());
  Write(profile, std::move(spaces), index);
  ReplaceTabs(browser, std::move(target));
}

void SwitchSpaceBy(BrowserWindowInterface* browser, int delta) {
  Profile* profile = browser->GetProfile();
  const base::ListValue spaces = ReadSpaces(profile);
  const int count = static_cast<int>(spaces.size());
  const int next =
      ((static_cast<int>(ActiveIndex(profile, spaces)) + delta) % count +
       count) %
      count;
  SwitchToSpace(browser, next);
}

void NewSpace(BrowserWindowInterface* browser) {
  Profile* profile = browser->GetProfile();
  base::ListValue spaces = ReadSpaces(profile);
  const std::string id = NextId(spaces);
  spaces.Append(base::DictValue()
                    .Set(kId, id)
                    .Set(kName, "Space " + base::NumberToString(
                                               spaces.size() + 1))
                    .Set(kTabs, base::ListValue()));
  const size_t active = ActiveIndex(profile, spaces);
  const size_t index = spaces.size() - 1;
  Write(profile, std::move(spaces), active);
  SwitchToSpace(browser, index);
}

void RenameActiveSpace(Profile* profile, const std::u16string& name) {
  std::u16string trimmed;
  base::TrimWhitespace(name, base::TRIM_ALL, &trimmed);
  if (trimmed.empty()) {
    return;
  }
  base::ListValue spaces = ReadSpaces(profile);
  const size_t active = ActiveIndex(profile, spaces);
  spaces[active].GetDict().Set(kName, trimmed.substr(0, 40));
  Write(profile, std::move(spaces), active);
}

void DeleteActiveSpace(BrowserWindowInterface* browser) {
  Profile* profile = browser->GetProfile();
  base::ListValue spaces = ReadSpaces(profile);
  if (spaces.size() < 2) {
    return;
  }
  const size_t active = ActiveIndex(profile, spaces);
  const size_t previous = active == 0 ? 1 : active - 1;
  // The window shows the previous space's tabs followed by this one's.
  std::vector<SpaceTab> merged =
      TabsFrom(*spaces[previous].GetDict().FindList(kTabs));
  for (SpaceTab tab : TabsFrom(CaptureTabs(browser))) {
    if (!merged.empty()) {
      tab.active = false;
    }
    merged.push_back(std::move(tab));
  }
  spaces[previous].GetDict().Set(kTabs, base::ListValue());
  spaces.erase(spaces.begin() + active);
  Write(profile, std::move(spaces), previous < active ? previous : 0);
  ReplaceTabs(browser, std::move(merged));
}

void OpenTabsAsleep(BrowserWindowInterface* browser,
                    const std::vector<SpaceTab>& tabs) {
  TabStripModel* model = browser->GetTabStripModel();
  const bool any_active = std::ranges::any_of(
      tabs, [](const SpaceTab& tab) { return tab.active; });
  for (size_t i = 0; i < tabs.size(); ++i) {
    const SpaceTab& tab = tabs[i];
    sessions::SerializedNavigationEntry entry;
    entry.set_index(0);
    entry.set_virtual_url(tab.url);
    entry.set_original_request_url(tab.url);
    entry.set_title(tab.title);
    entry.set_transition_type(ui::PAGE_TRANSITION_AUTO_BOOKMARK);
    entry.set_timestamp(base::Time::Now());
    const std::vector<sessions::SerializedNavigationEntry> navigations = {
        entry};
    const bool select = tab.active || (!any_active && i == 0);
    const int index =
        tab.pinned ? model->IndexOfFirstNonPinnedTab() : model->count();
    chrome::AddRestoredTab(browser, navigations, index,
                           /*selected_navigation=*/0,
                           /*extension_app_id=*/std::string(),
                           /*group=*/std::nullopt, select, tab.pinned,
                           base::TimeTicks(), base::Time(),
                           /*storage_namespace=*/nullptr,
                           sessions::SerializedUserAgentOverride(),
                           /*extra_data=*/{},
                           /*from_session_restore=*/false,
                           /*is_active_browser=*/std::nullopt);
  }
}

}  // namespace perch
