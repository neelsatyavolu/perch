// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_NOTIFICATIONS_PERCH_TASK_NOTIFICATION_HANDLER_H_
#define CHROME_BROWSER_NOTIFICATIONS_PERCH_TASK_NOTIFICATION_HANDLER_H_

#include <string>

#include "base/functional/callback.h"
#include "chrome/browser/notifications/notification_handler.h"

// Clicks on Perch's "waiting for you" notices. They are PERCH_TASK rather than
// TRANSIENT so macOS shows them as system banners: Chromium keeps TRANSIENT
// notices in its own pop-up. A system banner carries no delegate, so the click
// comes back here by its notification id.
class PerchTaskNotificationHandler : public NotificationHandler {
 public:
  using ClickCallback = base::RepeatingCallback<void(const std::string& id)>;

  PerchTaskNotificationHandler();
  ~PerchTaskNotificationHandler() override;

  PerchTaskNotificationHandler(const PerchTaskNotificationHandler&) = delete;
  PerchTaskNotificationHandler& operator=(const PerchTaskNotificationHandler&) =
      delete;

  // Set once by chrome/browser/perch/agent/task_status.cc, which opens the chat.
  static void SetClickCallback(ClickCallback callback);

  // NotificationHandler:
  void OnClick(Profile* profile,
               const GURL& origin,
               const std::string& notification_id,
               const std::optional<int>& action_index,
               const std::optional<std::u16string>& reply,
               base::OnceClosure completed_closure) override;
};

#endif  // CHROME_BROWSER_NOTIFICATIONS_PERCH_TASK_NOTIFICATION_HANDLER_H_
