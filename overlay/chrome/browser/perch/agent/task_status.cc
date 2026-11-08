// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/task_status.h"

#include <map>
#include <set>

#include "base/functional/bind.h"
#include "base/no_destructor.h"
#include "base/strings/utf_string_conversions.h"
#include "chrome/browser/notifications/notification_display_service.h"
#include "chrome/browser/notifications/notification_display_service_factory.h"
#include "chrome/browser/notifications/notification_handler.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/tab_list/tab_list_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface_iterator.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "chrome/browser/ui/side_panel/side_panel_entry_id.h"
#include "chrome/browser/ui/side_panel/side_panel_ui.h"
#include "components/tabs/public/tab_interface.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/invalidate_type.h"
#include "content/public/browser/page_navigator.h"
#include "content/public/browser/web_contents.h"
#include "ui/base/window_open_disposition.h"
#include "ui/message_center/public/cpp/notification.h"
#include "ui/message_center/public/cpp/notification_delegate.h"
#include "ui/message_center/public/cpp/notifier_id.h"
#include "url/gurl.h"

namespace perch {

namespace {

struct ChatStatus {
  TaskState state = TaskState::kIdle;
  std::vector<std::string> targets;
  bool notified = false;
};

std::map<std::string, ChatStatus>& Chats() {
  static base::NoDestructor<std::map<std::string, ChatStatus>> chats;
  return *chats;
}

base::RepeatingClosureList& WaitingListeners() {
  static base::NoDestructor<base::RepeatingClosureList> listeners;
  return *listeners;
}

bool AnyWaiting() {
  for (const auto& [chat_id, chat] : Chats()) {
    if (chat.state == TaskState::kWaiting) {
      return true;
    }
  }
  return false;
}

content::WebContents* ContentsFor(const std::string& target_id) {
  scoped_refptr<content::DevToolsAgentHost> host =
      content::DevToolsAgentHost::GetForId(target_id);
  return host ? host->GetWebContents() : nullptr;
}

std::string TargetIdFor(content::WebContents* contents) {
  return content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId();
}

void Redraw(const std::vector<std::string>& targets) {
  for (const std::string& id : targets) {
    if (content::WebContents* contents = ContentsFor(id)) {
      contents->NotifyNavigationStateChanged(content::INVALIDATE_TYPE_TAB);
    }
  }
}

GURL ChatUrl(const std::string& chat_id) {
  return GURL("chrome://perch-chat/?chat=" + chat_id);
}

bool AnyWindowActive() {
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    if (browser->IsActive()) {
      return true;
    }
  }
  return false;
}

// One macOS notification for a chat that waits on the person.
void Notify(const std::string& chat_id,
            const std::vector<std::string>& targets,
            const std::string& title) {
  Profile* profile = nullptr;
  if (!targets.empty()) {
    if (content::WebContents* contents = ContentsFor(targets.front())) {
      profile = Profile::FromBrowserContext(contents->GetBrowserContext());
    }
  }
  if (!profile) {
    BrowserWindowInterface* last =
        GetLastActiveBrowserWindowInterfaceWithAnyProfile();
    profile = last ? last->GetProfile() : nullptr;
  }
  NotificationDisplayService* service =
      profile ? NotificationDisplayServiceFactory::GetForProfile(profile)
              : nullptr;
  if (!service) {
    return;
  }
  const std::string target = targets.empty() ? std::string() : targets.front();
  message_center::Notification notification(
      message_center::NOTIFICATION_TYPE_SIMPLE, "perch-wait-" + chat_id,
      base::UTF8ToUTF16(title), u"Perch is waiting for you", ui::ImageModel(),
      u"Perch", GURL(),
      message_center::NotifierId(message_center::NotifierType::SYSTEM_COMPONENT,
                                 "perch"),
      message_center::RichNotificationData(),
      base::MakeRefCounted<message_center::HandleNotificationClickDelegate>(
          base::BindRepeating(
              [](std::string chat, std::string tab) {
                RevealChat(chat, tab, /*side=*/!tab.empty());
              },
              chat_id, target)));
  service->Display(NotificationHandler::Type::TRANSIENT, notification,
                   /*metadata=*/nullptr);
}

}  // namespace

void SetTaskStatus(const std::string& chat_id,
                   TaskState state,
                   const std::vector<std::string>& target_ids,
                   const std::string& title) {
  const bool waiting_before = AnyWaiting();
  ChatStatus& chat = Chats()[chat_id];
  std::vector<std::string> changed = chat.targets;
  changed.insert(changed.end(), target_ids.begin(), target_ids.end());
  const bool was_waiting = chat.state == TaskState::kWaiting;
  chat.state = state;
  chat.targets = state == TaskState::kIdle ? std::vector<std::string>()
                                           : target_ids;
  if (state != TaskState::kWaiting) {
    chat.notified = false;
  } else if (!was_waiting && !chat.notified && !title.empty() &&
             !AnyWindowActive()) {
    chat.notified = true;
    Notify(chat_id, target_ids, title);
  }
  if (state == TaskState::kIdle) {
    Chats().erase(chat_id);
  }
  Redraw(changed);
  if (AnyWaiting() != waiting_before) {
    WaitingListeners().Notify();
  }
}

bool IsAnyChatWaiting() {
  return AnyWaiting();
}

base::CallbackListSubscription OnWaitingChanged(
    base::RepeatingClosure callback) {
  return WaitingListeners().Add(std::move(callback));
}

bool IsTaskRunningIn(content::WebContents* contents) {
  if (!contents || Chats().empty() ||
      !content::DevToolsAgentHost::HasFor(contents)) {
    return false;
  }
  const std::string id = TargetIdFor(contents);
  for (const auto& [chat_id, chat] : Chats()) {
    if (chat.state == TaskState::kRunning &&
        std::find(chat.targets.begin(), chat.targets.end(), id) !=
            chat.targets.end()) {
      return true;
    }
  }
  return false;
}

void ClearAllTaskStatus() {
  std::vector<std::string> all;
  for (const auto& [chat_id, chat] : Chats()) {
    all.insert(all.end(), chat.targets.begin(), chat.targets.end());
  }
  const bool was_waiting = AnyWaiting();
  Chats().clear();
  Redraw(all);
  if (was_waiting) {
    WaitingListeners().Notify();
  }
}

bool RevealChat(const std::string& chat_id,
                const std::string& target_id,
                bool side) {
  if (side) {
    content::WebContents* contents = ContentsFor(target_id);
    tabs::TabInterface* tab =
        contents ? tabs::TabInterface::MaybeGetFromContents(contents) : nullptr;
    BrowserWindowInterface* browser =
        tab ? tab->GetBrowserWindowInterface() : nullptr;
    if (!browser) {
      return false;
    }
    if (TabListInterface* list = TabListInterface::From(browser)) {
      list->ActivateTab(tab->GetHandle());
    }
    if (BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser)) {
      view->Activate();
    }
    if (SidePanelUI* panel = SidePanelUI::From(browser)) {
      panel->Show(SidePanelEntryId::kPerch);
    }
    return true;
  }
  const GURL url = ChatUrl(chat_id);
  for (BrowserWindowInterface* browser : GetAllBrowserWindowInterfaces()) {
    TabStripModel* tabs = browser->GetTabStripModel();
    for (int i = 0; tabs && i < tabs->count(); ++i) {
      if (tabs->GetWebContentsAt(i)->GetVisibleURL() == url) {
        tabs->ActivateTabAt(i);
        if (BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser)) {
          view->Activate();
        }
        return true;
      }
    }
  }
  BrowserWindowInterface* last =
      GetLastActiveBrowserWindowInterfaceWithAnyProfile();
  if (!last) {
    return false;
  }
  last->OpenURL(content::OpenURLParams(url, content::Referrer(),
                                       WindowOpenDisposition::kNewForegroundTab,
                                       ui::PAGE_TRANSITION_AUTO_BOOKMARK,
                                       false),
                {});
  return true;
}

}  // namespace perch
