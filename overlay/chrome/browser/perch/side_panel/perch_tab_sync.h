// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_SIDE_PANEL_PERCH_TAB_SYNC_H_
#define CHROME_BROWSER_PERCH_SIDE_PANEL_PERCH_TAB_SYNC_H_

#include <deque>
#include <memory>
#include <string>

#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/timer/timer.h"
#include "base/values.h"

class Profile;

namespace content {
class WebContents;
}

namespace network {
class SimpleURLLoader;
}

namespace tabs {
class TabInterface;
}

namespace perch {

// A tab's id for side chats: a random GUID that stays with the tab for its
// life, also when the tab is discarded and its WebContents replaced.
std::string TabIdFor(tabs::TabInterface* tab);
// Whether the user left the Perch sidebar open on this tab.
bool IsPanelOpenFor(tabs::TabInterface* tab);
void SetPanelOpenFor(tabs::TabInterface* tab, bool open);
void ForgetTab(tabs::TabInterface* tab);

// Tells perchd's app API about tabs (docs/design/webui-hosting.md, "The side
// panel, one chat per tab"): which tab is active in each window, title and
// address changes, and closed tabs. Requests go out one at a time, in order.
// When perchd is not reachable, everything is sent again in full once it is.
class PerchTabSync {
 public:
  static PerchTabSync& Get();

  PerchTabSync(const PerchTabSync&) = delete;
  PerchTabSync& operator=(const PerchTabSync&) = delete;

  void Activate(Profile* profile,
                const std::string& window_id,
                tabs::TabInterface* tab);
  void Update(Profile* profile,
              const std::string& window_id,
              tabs::TabInterface* tab);
  void Remove(Profile* profile, const std::string& tab_id);
  // Sends every open tab and each window's active tab.
  void ResyncAll(Profile* profile);

 private:
  friend class base::NoDestructor<PerchTabSync>;
  struct Request;

  PerchTabSync();
  ~PerchTabSync();

  void Enqueue(Profile* profile,
               std::string method,
               std::string path,
               std::optional<base::DictValue> body);
  void SendNext();
  void OnDone(std::unique_ptr<network::SimpleURLLoader> loader,
              std::optional<std::string> response);

  std::deque<std::unique_ptr<Request>> queue_;
  bool in_flight_ = false;
  bool needs_resync_ = false;
  base::OneShotTimer retry_;
  base::WeakPtr<Profile> profile_;
  base::WeakPtrFactory<PerchTabSync> weak_factory_{this};
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_SIDE_PANEL_PERCH_TAB_SYNC_H_
