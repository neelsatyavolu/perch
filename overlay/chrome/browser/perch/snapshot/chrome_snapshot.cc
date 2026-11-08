// Copyright 2026 The Perch Authors
// Use of this source code is governed by the MIT license in Perch's LICENSE file.

#include "chrome/browser/perch/snapshot/chrome_snapshot.h"

#include <memory>
#include <string>
#include <utility>
#include <vector>

#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/logging.h"
#include "base/memory/raw_ptr.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "chrome/browser/lifetime/application_lifetime.h"
#include "chrome/browser/perch/perch_pref_names.h"
#include "chrome/browser/profiles/profile.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/browser/ui/tabs/tab_strip_model.h"
#include "chrome/browser/ui/views/frame/browser_view.h"
#include "components/prefs/pref_service.h"
#include "components/viz/common/frame_sinks/copy_output_request.h"
#include "components/viz/common/frame_sinks/copy_output_result.h"
#include "content/public/browser/navigation_controller.h"
#include "content/public/browser/web_contents.h"
#include "third_party/skia/include/core/SkBitmap.h"
#include "ui/compositor/layer.h"
#include "ui/gfx/codec/png_codec.h"
#include "ui/views/widget/widget.h"
#include "url/gurl.h"

namespace perch {

namespace {

constexpr char kSnapshotSwitch[] = "perch-chrome-snapshot";
constexpr char kStatesSwitch[] = "perch-snapshot-states";
constexpr base::TimeDelta kSettle = base::Milliseconds(1500);

bool g_started = false;

void WritePng(base::FilePath path, SkBitmap bitmap) {
  std::optional<std::vector<uint8_t>> png =
      gfx::PNGCodec::EncodeBGRASkBitmap(bitmap, /*discard_transparency=*/false);
  if (!png || !base::WriteFile(path, *png)) {
    LOG(ERROR) << "Perch snapshot: could not write " << path;
    return;
  }
  LOG(WARNING) << "Perch snapshot: wrote " << path;
}

// Renders one state after another, then quits.
class Snapshotter {
 public:
  Snapshotter(BrowserWindowInterface* browser,
              base::FilePath dir,
              std::vector<std::string> states)
      : browser_(browser), dir_(std::move(dir)), states_(std::move(states)) {}

  void Next() {
    if (index_ >= states_.size()) {
      chrome::AttemptExit();
      return;
    }
    Apply(states_[index_]);
    base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
        FROM_HERE,
        base::BindOnce(&Snapshotter::Capture, base::Unretained(this)),
        kSettle);
  }

 private:
  void Apply(const std::string& state) {
    PrefService* prefs = browser_->GetProfile()->GetPrefs();
    if (state.starts_with("theme-")) {
      prefs->SetString(prefs::kAppearanceTheme, state.substr(6));
    } else if (state.starts_with("accent-")) {
      prefs->SetString(prefs::kAppearanceAccent, state.substr(7));
    } else if (state == "hidden-chrome") {
      prefs->SetBoolean(prefs::kAppearanceHideChrome, true);
      // The address bar has focus in a new window, which shows the bars.
      if (content::WebContents* page =
              browser_->GetTabStripModel()->GetActiveWebContents()) {
        page->Focus();
      }
    } else if (state == "tabs") {
      TabStripModel* tabs = browser_->GetTabStripModel();
      for (const char* url : {"about:blank", "chrome://version",
                              "chrome://perch-settings", "chrome://flags",
                              "chrome://perch-memory", "chrome://downloads",
                              "chrome://history"}) {
        if (tabs->count() >= 8) {
          break;
        }
        BrowserView::GetBrowserViewForBrowser(browser_)
            ->browser()
            ->OpenURL(content::OpenURLParams(
                          GURL(url), content::Referrer(),
                          WindowOpenDisposition::kNewBackgroundTab,
                          ui::PAGE_TRANSITION_TYPED, false),
                      {});
      }
    }
  }

  void Capture() {
    BrowserView* view = BrowserView::GetBrowserViewForBrowser(browser_);
    ui::Layer* layer =
        view && view->GetWidget() ? view->GetWidget()->GetLayer() : nullptr;
    if (!layer) {
      LOG(ERROR) << "Perch snapshot: the window has no layer";
      ++index_;
      Next();
      return;
    }
    const base::FilePath path = dir_.AppendASCII(states_[index_] + ".png");
    layer->RequestCopyOfOutput(std::make_unique<viz::CopyOutputRequest>(
        viz::CopyOutputRequest::ResultFormat::RGBA,
        viz::CopyOutputRequest::ResultDestination::kSystemMemory,
        base::BindOnce(&Snapshotter::Done, base::Unretained(this), path)));
  }

  void Done(base::FilePath path, std::unique_ptr<viz::CopyOutputResult> r) {
    if (r && !r->IsEmpty()) {
      auto scoped = r->ScopedAccessSkBitmap();
      SkBitmap bitmap = scoped.GetOutScopedBitmap();
      base::ThreadPool::PostTask(
          FROM_HERE, {base::MayBlock(), base::TaskPriority::USER_VISIBLE},
          base::BindOnce(&WritePng, path, std::move(bitmap)));
    } else {
      LOG(ERROR) << "Perch snapshot: the compositor returned no frame for "
                 << path;
    }
    ++index_;
    Next();
  }

  raw_ptr<BrowserWindowInterface> browser_;
  const base::FilePath dir_;
  const std::vector<std::string> states_;
  size_t index_ = 0;
};

}  // namespace

void MaybeStartChromeSnapshot(BrowserWindowInterface* browser) {
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (g_started || !command_line->HasSwitch(kSnapshotSwitch)) {
    return;
  }
  g_started = true;
  const base::FilePath dir = command_line->GetSwitchValuePath(kSnapshotSwitch);
  std::string list = command_line->GetSwitchValueASCII(kStatesSwitch);
  if (list.empty()) {
    list = "default";
  }
  std::vector<std::string> states = base::SplitString(
      list, ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
  // Lives until Perch quits.
  auto* snapshotter = new Snapshotter(browser, dir, std::move(states));
  base::SingleThreadTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE,
      base::BindOnce(&Snapshotter::Next, base::Unretained(snapshotter)),
      base::Seconds(2));
}

}  // namespace perch
