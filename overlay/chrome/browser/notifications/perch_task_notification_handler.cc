// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/notifications/perch_task_notification_handler.h"

#include <utility>

#include "base/functional/callback_helpers.h"
#include "base/no_destructor.h"
#include "chrome/browser/notifications/notification_display_service.h"
#include "chrome/browser/notifications/notification_display_service_factory.h"

namespace {

PerchTaskNotificationHandler::ClickCallback& Callback() {
  static base::NoDestructor<PerchTaskNotificationHandler::ClickCallback>
      callback;
  return *callback;
}

}  // namespace

PerchTaskNotificationHandler::PerchTaskNotificationHandler() = default;
PerchTaskNotificationHandler::~PerchTaskNotificationHandler() = default;

// static
void PerchTaskNotificationHandler::SetClickCallback(ClickCallback callback) {
  Callback() = std::move(callback);
}

void PerchTaskNotificationHandler::OnClick(
    Profile* profile,
    const GURL& origin,
    const std::string& notification_id,
    const std::optional<int>& action_index,
    const std::optional<std::u16string>& reply,
    base::OnceClosure completed_closure) {
  base::ScopedClosureRunner runner(std::move(completed_closure));
  if (profile) {
    if (auto* service =
            NotificationDisplayServiceFactory::GetForProfile(profile)) {
      service->Close(NotificationHandler::Type::PERCH_TASK, notification_id);
    }
  }
  if (Callback()) {
    Callback().Run(notification_id);
  }
}
