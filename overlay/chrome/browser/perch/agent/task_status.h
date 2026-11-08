// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_TASK_STATUS_H_
#define CHROME_BROWSER_PERCH_AGENT_TASK_STATUS_H_

#include <string>
#include <vector>

#include "base/callback_list.h"
#include "base/functional/callback_forward.h"

namespace content {
class WebContents;
}

namespace perch {

// What perchd says each chat is doing (Perch.setTaskStatus, plan 3b task 6).
enum class TaskState { kIdle, kRunning, kWaiting };

// Records a chat's state and the tabs (DevTools target ids) it drives, and
// redraws those tabs. A chat that starts waiting while no Perch window is
// active shows one notification titled `title`; clicking it reveals the chat.
void SetTaskStatus(const std::string& chat_id,
                   TaskState state,
                   const std::vector<std::string>& target_ids,
                   const std::string& title);

// Whether a running chat drives this tab: the tab shows the perch dot.
bool IsTaskRunningIn(content::WebContents* contents);

// Whether any chat waits on the person: the profile button shows a still dot.
bool IsAnyChatWaiting();
// Runs `callback` whenever that changes.
base::CallbackListSubscription OnWaitingChanged(base::RepeatingClosure callback);

// perchd went away: every dot clears.
void ClearAllTaskStatus();

// Shows a chat: `side` activates the tab (a DevTools target id) and opens the
// side panel; `full` opens or focuses chrome://perch-chat for the chat.
bool RevealChat(const std::string& chat_id,
                const std::string& target_id,
                bool side);

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_TASK_STATUS_H_
