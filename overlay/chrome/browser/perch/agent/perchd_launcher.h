// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#ifndef CHROME_BROWSER_PERCH_AGENT_PERCHD_LAUNCHER_H_
#define CHROME_BROWSER_PERCH_AGENT_PERCHD_LAUNCHER_H_

#include <string>

#include "base/files/file_path.h"
#include "base/files/scoped_file.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/process/process.h"
#include "base/time/time.h"

namespace perch {

// Switches.
inline constexpr char kNoAgentSwitch[] = "perch-no-agent";
inline constexpr char kPerchdPathSwitch[] = "perch-perchd-path";
inline constexpr char kUiDirSwitch[] = "perch-ui-dir";

// Starts perchd, Perch's agent, as a child of the browser (spec 7.1). perchd
// speaks CDP to the browser over a private socket pair on its fds 3 and 4,
// through Chromium's own pipe handler, and reads its app server's port and
// token from fd 5. No DevTools port is opened. When perchd exits, the browser
// keeps running and starts it again after a short wait.
class PerchdLauncher {
 public:
  static PerchdLauncher& Get();

  PerchdLauncher(const PerchdLauncher&) = delete;
  PerchdLauncher& operator=(const PerchdLauncher&) = delete;

  // Starts perchd once per browser process; later calls do nothing.
  void MaybeStart();

  // Whether the agent runs in this browser process.
  bool enabled() const { return enabled_; }
  int port() const { return port_; }
  const std::string& token() const { return token_; }
  // "http://127.0.0.1:<port>", or empty when the agent is off.
  std::string ApiOrigin() const;
  // The folder with the built chat pages (ui/dist).
  base::FilePath UiDir() const;

  // A started perchd and the browser's ends of its sockets.
  struct Launched;

 private:
  friend class base::NoDestructor<PerchdLauncher>;

  PerchdLauncher();
  ~PerchdLauncher();

  void Launch();
  void OnLaunched(std::unique_ptr<Launched> launched);
  void OnPipeClosed();
  void ScheduleRestart();

  bool started_ = false;
  bool enabled_ = false;
  int port_ = 0;
  std::string token_;
  base::FilePath perchd_path_;
  base::FilePath user_data_dir_;
  base::Process process_;
  base::ScopedFD browser_read_;
  base::ScopedFD browser_write_;
  base::ScopedFD config_;
  base::TimeTicks launched_at_;
  int restarts_ = 0;
  base::WeakPtrFactory<PerchdLauncher> weak_factory_{this};
};

}  // namespace perch

#endif  // CHROME_BROWSER_PERCH_AGENT_PERCHD_LAUNCHER_H_
