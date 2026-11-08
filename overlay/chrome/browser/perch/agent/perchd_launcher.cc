// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/agent/perchd_launcher.h"

#include "chrome/browser/perch/agent/perch_devtools.h"
#include "chrome/browser/perch/keys/key_broker.h"

#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <string>
#include <utility>

#include "base/apple/bundle_locations.h"
#include "base/apple/scoped_cftyperef.h"
#include "base/base64url.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/posix/eintr_wrapper.h"
#include "base/functional/bind.h"
#include "base/json/json_writer.h"
#include "base/logging.h"
#include "base/path_service.h"
#include "base/process/kill.h"
#include "base/process/launch.h"
#include "base/rand_util.h"
#include "base/strings/stringprintf.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/lifetime/browser_shutdown.h"
#include "chrome/common/chrome_paths.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/common/content_switches.h"

namespace perch {

namespace {

// The origins of Perch's pages that may call perchd's app API.
constexpr char kSideChatOrigin[] =
    "chrome-untrusted://perch-side-chat.top-chrome";
constexpr char kChatOrigin[] = "chrome://perch-chat";
constexpr int64_t kLogRotateBytes = 5 * 1024 * 1024;
// How long a stopped agent's sockets stay open after the pipe handler stops.
constexpr base::TimeDelta kRetireFdsAfter = base::Seconds(30);
// Chromium's pipe handler reads "<read>,<write>" from this switch
// (content/browser/devtools/devtools_agent_host_impl.cc, Perch's POSIX branch).
constexpr char kRemoteDebuggingIoPipes[] = "remote-debugging-io-pipes";

// A free loopback port for perchd's app server. perchd binds it at once; if
// another process takes it first, perchd exits and the next launch picks again.
int PickPort() {
  base::ScopedFD fd(socket(AF_INET, SOCK_STREAM, 0));
  if (!fd.is_valid()) {
    return 0;
  }
  sockaddr_in addr = {};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  addr.sin_port = 0;
  if (bind(fd.get(), reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
    return 0;
  }
  socklen_t len = sizeof(addr);
  if (getsockname(fd.get(), reinterpret_cast<sockaddr*>(&addr), &len) != 0) {
    return 0;
  }
  return ntohs(addr.sin_port);
}

std::string NewToken() {
  std::string token;
  base::Base64UrlEncode(base::RandBytesAsVector(32),
                        base::Base64UrlEncodePolicy::OMIT_PADDING, &token);
  return token;
}

bool SocketPair(base::ScopedFD& browser_end, base::ScopedFD& child_end) {
  int fds[2];
  if (socketpair(AF_UNIX, SOCK_STREAM, 0, fds) != 0) {
    return false;
  }
  browser_end.reset(fds[0]);
  child_end.reset(fds[1]);
  // The child gets its end through fds_to_remap; nothing else should.
  fcntl(fds[0], F_SETFD, FD_CLOEXEC);
  fcntl(fds[1], F_SETFD, FD_CLOEXEC);
  return true;
}

}  // namespace

struct PerchdLauncher::Launched {
  base::Process process;
  base::ScopedFD browser_read;
  base::ScopedFD browser_write;
  base::ScopedFD config;
};

namespace {

// Runs on a thread that may block: makes the sockets, opens the log and
// starts perchd, then sends it its settings on fd 5.
std::unique_ptr<PerchdLauncher::Launched> LaunchPerchd(
    base::FilePath perchd,
    base::FilePath user_data_dir,
    std::string config_line) {
  auto launched = std::make_unique<PerchdLauncher::Launched>();
  base::ScopedFD to_browser_child, to_perchd_child;
  if (!SocketPair(launched->browser_read, to_browser_child) ||
      !SocketPair(launched->browser_write, to_perchd_child)) {
    PLOG(ERROR) << "Perch: could not make the agent's sockets";
    return nullptr;
  }
  int config_fds[2];
  if (pipe(config_fds) != 0) {
    PLOG(ERROR) << "Perch: could not make the agent's settings pipe";
    return nullptr;
  }
  base::ScopedFD config_child(config_fds[0]);
  launched->config.reset(config_fds[1]);
  fcntl(config_fds[0], F_SETFD, FD_CLOEXEC);
  fcntl(config_fds[1], F_SETFD, FD_CLOEXEC);

  const base::FilePath log_dir = user_data_dir.Append("Perch Agent");
  base::CreateDirectory(log_dir);
  const base::FilePath log_path = log_dir.Append("perchd.log");
  std::optional<int64_t> size = base::GetFileSize(log_path);
  if (size && *size > kLogRotateBytes) {
    base::Move(log_path, log_dir.Append("perchd.log.1"));
  }
  base::ScopedFD log(HANDLE_EINTR(
      open(log_path.value().c_str(), O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC,
           0600)));

  base::CommandLine command(perchd);
  command.AppendArg("serve");
  command.AppendArg("--browser-fds");
  base::LaunchOptions options;
  options.fds_to_remap.emplace_back(to_perchd_child.get(), 3);
  options.fds_to_remap.emplace_back(to_browser_child.get(), 4);
  options.fds_to_remap.emplace_back(config_child.get(), 5);
  if (log.is_valid()) {
    options.fds_to_remap.emplace_back(log.get(), STDOUT_FILENO);
    options.fds_to_remap.emplace_back(log.get(), STDERR_FILENO);
  }
  options.environment["PERCH_DATA_DIR"] = user_data_dir.value();
  options.current_directory = log_dir;
  launched->process = base::LaunchProcess(command, options);
  if (!launched->process.IsValid()) {
    LOG(ERROR) << "Perch: could not start the agent at " << perchd;
    return nullptr;
  }
  if (!base::WriteFileDescriptor(launched->config.get(), config_line)) {
    PLOG(ERROR) << "Perch: could not send the agent its settings";
  }
  return launched;
}

}  // namespace

namespace {

bool IsAgentDisabledByPolicy() {
  CFStringRef domain = CFSTR("co.xanom.perch");
  CFStringRef key = CFSTR("AgentEnabled");
  if (!CFPreferencesAppValueIsForced(key, domain)) {
    return false;
  }
  base::apple::ScopedCFTypeRef<CFPropertyListRef> value(
      CFPreferencesCopyAppValue(key, domain));
  return value && CFGetTypeID(value.get()) == CFBooleanGetTypeID() &&
         !CFBooleanGetValue(static_cast<CFBooleanRef>(value.get()));
}

}  // namespace

// static
PerchdLauncher& PerchdLauncher::Get() {
  static base::NoDestructor<PerchdLauncher> instance;
  return *instance;
}

PerchdLauncher::PerchdLauncher() = default;
PerchdLauncher::~PerchdLauncher() = default;

void PerchdLauncher::MaybeStart() {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (started_) {
    return;
  }
  started_ = true;
  const base::CommandLine& command_line =
      *base::CommandLine::ForCurrentProcess();
  // In development perchd launches the browser itself over this pipe.
  if (command_line.HasSwitch(::switches::kRemoteDebuggingPipe) ||
      command_line.HasSwitch(kNoAgentSwitch)) {
    return;
  }
  // Headless runs (tests, snapshots) opt in.
  if (command_line.HasSwitch("headless") &&
      !command_line.HasSwitch(kAgentInHeadlessSwitch)) {
    return;
  }
  // An administrator turned the agent off (AgentEnabled).
  if (IsAgentDisabledByPolicy()) {
    return;
  }
  perchd_path_ = command_line.GetSwitchValuePath(kPerchdPathSwitch);
  if (perchd_path_.empty()) {
    perchd_path_ = base::apple::FrameworkBundlePath()
                       .Append("Helpers")
                       .Append("perchd");
  }
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &user_data_dir_)) {
    return;
  }
  port_ = PickPort();
  if (port_ == 0) {
    LOG(ERROR) << "Perch: no free loopback port for the agent";
    return;
  }
  token_ = NewToken();
  browser_token_ = NewToken();
  enabled_ = true;
  Launch();
}

std::string PerchdLauncher::ApiOrigin() const {
  return enabled_ ? base::StringPrintf("http://127.0.0.1:%d", port_)
                  : std::string();
}

base::FilePath PerchdLauncher::UiDir() const {
  base::FilePath dir =
      base::CommandLine::ForCurrentProcess()->GetSwitchValuePath(kUiDirSwitch);
  if (!dir.empty()) {
    return dir;
  }
  return base::apple::FrameworkBundlePath()
      .Append("Resources")
      .Append("perch_ui");
}

void PerchdLauncher::Launch() {
  base::DictValue config;
  config.Set("op", "app");
  config.Set("port", port_);
  config.Set("token", token_);
  config.Set("browserToken", browser_token_);
  config.Set("dataDir", user_data_dir_.value());
  base::ListValue origins;
  origins.Append(kSideChatOrigin);
  origins.Append(kChatOrigin);
  origins.Append("chrome-untrusted://perch-chat");
  for (const char* page : {"settings", "newtab", "memory", "routines", "import",
                           "welcome"}) {
    origins.Append(std::string("chrome://perch-") + page);
  }
  config.Set("origins", std::move(origins));
  std::string line = base::WriteJson(config).value_or("{}") + "\n";
  base::ThreadPool::PostTaskAndReplyWithResult(
      FROM_HERE,
      {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
       base::TaskShutdownBehavior::CONTINUE_ON_SHUTDOWN},
      base::BindOnce(&LaunchPerchd, perchd_path_, user_data_dir_,
                     std::move(line)),
      base::BindOnce(&PerchdLauncher::OnLaunched,
                     weak_factory_.GetWeakPtr()));
}

void PerchdLauncher::OnLaunched(std::unique_ptr<Launched> launched) {
  DCHECK_CURRENTLY_ON(content::BrowserThread::UI);
  if (browser_shutdown::HasShutdownStarted()) {
    return;
  }
  if (!launched) {
    ScheduleRestart();
    return;
  }
  process_ = std::move(launched->process);
  browser_read_ = std::move(launched->browser_read);
  browser_write_ = std::move(launched->browser_write);
  config_ = std::move(launched->config);
  launched_at_ = base::TimeTicks::Now();
  // Chromium's pipe handler reads the two descriptors from this switch.
  base::CommandLine::ForCurrentProcess()->AppendSwitchASCII(
      kRemoteDebuggingIoPipes,
      base::StringPrintf("%d,%d", browser_read_.get(), browser_write_.get()));
  content::DevToolsAgentHost::StartRemoteDebuggingPipeHandler(base::BindOnce(
      &PerchdLauncher::OnPipeClosed, weak_factory_.GetWeakPtr()));
  // Profile keys follow the settings line on the same pipe (plan 3b task 3).
  KeyBroker::Get().OnPerchdLaunched(base::BindRepeating(
      [](int fd, std::string line) {
        base::ScopedFD copy(HANDLE_EINTR(dup(fd)));
        if (!copy.is_valid()) {
          return;
        }
        base::ThreadPool::PostTask(
            FROM_HERE,
            {base::MayBlock(), base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN},
            base::BindOnce(
                [](base::ScopedFD out, std::string text) {
                  base::WriteFileDescriptor(out.get(), text);
                },
                std::move(copy), std::move(line)));
      },
      config_.get()));
}

void PerchdLauncher::OnPipeClosed() {
  if (browser_shutdown::HasShutdownStarted()) {
    return;
  }
  // Dots, tab holds and the event channel belong to the perchd that left.
  OnPerchdDisconnected();
  LOG(WARNING) << "Perch: the agent stopped; starting it again";
  content::DevToolsAgentHost::StopRemoteDebuggingPipeHandler();
  // The pipe handler's reader and writer threads wind down on their own after
  // a shutdown() of these sockets and may still hold the descriptor numbers.
  // Closing them now could hand those numbers to the next launch's sockets
  // while an old writer still writes, so close them well after.
  base::ThreadPool::PostDelayedTask(
      FROM_HERE, {base::MayBlock(), base::TaskPriority::BEST_EFFORT},
      base::BindOnce([](base::ScopedFD read, base::ScopedFD write,
                        base::ScopedFD config) {},
                     std::move(browser_read_), std::move(browser_write_),
                     std::move(config_)),
      kRetireFdsAfter);
  if (process_.IsValid()) {
    base::EnsureProcessTerminated(std::move(process_));
  }
  if (base::TimeTicks::Now() - launched_at_ > base::Minutes(1)) {
    restarts_ = 0;
  }
  ScheduleRestart();
}

void PerchdLauncher::ScheduleRestart() {
  static constexpr std::array<base::TimeDelta, 3> kBackoff = {
      base::Seconds(1), base::Seconds(5), base::Seconds(30)};
  const base::TimeDelta delay =
      kBackoff[std::min<size_t>(restarts_, kBackoff.size() - 1)];
  ++restarts_;
  content::GetUIThreadTaskRunner({})->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&PerchdLauncher::Launch, weak_factory_.GetWeakPtr()),
      delay);
}

}  // namespace perch
